# Local AI engine

`@kuro/ai` implements the existing public `AiPort` from `@kuro/contracts`, using pinned
QVAC SDK/inference **0.19.0**. The current contracts, SQLite core, transport and pnpm
workspace remain authoritative. See [D27](../../docs/decisions/D27-qvac-adapter-integration.md).

The adapter embeds identified blocks, ranks only the supplied authorized vectors,
prepares exact summary manifests and executes local generation. Core owns permissions,
SQL filtering, the persistent queue, human approval, delivery and literal quote
reconstruction. This package never opens a database or chooses a recipient.

## Host composition

```ts
import { createAiAdapter } from '@kuro/ai';
import { openCore } from '@kuro/core';

const ai = createAiAdapter();
const core = await openCore({ ...hostDependencies, ai: ai.port });
// Schedule core.tick() from the trusted host and expose only core.app over IPC.
// Stop active core work before closing the single device runtime:
await core.stop();
await ai.close();
```

Create one core scheduler and one QVAC runtime per device. The runtime has a
single-operation guard, not a second queue. Cancellation marks the active operation
before requesting native cancellation; even if that request fails, the guard stays
occupied until the original operation settles and discards its late output. A stuck
native provider requires host recovery. Lifecycle stays outside `AiPort`.

`createAiPort(runtime)` is available for hosts that already retain and close their
injected runtime. Prefer `createAiAdapter()` when this package creates the runtime.
`QvacClient` accepts optional `embeddingFallbackSrc` and `generationFallbackSrc`
HTTP/local paths; `null` disables a fallback. Defaults use the exact pinned model
revisions, and QVAC verifies fallback bytes against the registry checksum.

## Profiles and manifests

- `QVAC_EMBEDDING_PROFILE`: `GTE_LARGE_FP16`, 1024 dimensions, `unit` normalization,
  `utf8-v1` segmentation. The adapter verifies the complete pinned profile, normalizes
  to unit length and validates the final Float32 representation and block identities.
- `QVAC_GENERATION_PROFILE`: `QWEN3_1_7B_INST_Q4`, 4096 context tokens, 512 output tokens.
  The checksum and tokenizer/model identity come from the pinned SDK registry.

Preparation uses the shared `summaryContext`, `preparationDigest` and
`validatePreparation`. It accounts for the question, source aliases, exact passages,
references, omissions, profile and prompt/schema versions. UTF-8 byte length bounds
context tokens conservatively; passages that do not fit are explicitly omitted.
Execution accepts the persisted context unchanged, with no repair prompt or hidden
history. Native context overflow and token-limit termination fail explicitly. The pinned SDK
defines an omitted stop reason as natural EOS; the adapter normalizes that documented
case and rejects unknown terminal values. Model JSON is strictly limited to
`status` and bounded `claims`; it cannot supply job IDs, digests or quote text. Summaries
remain private drafts requiring human semantic review.

## Validation

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:ai
pnpm --filter @kuro/ai-harness harness
pnpm --filter @kuro/ai-harness harness --with-qvac
```

`@kuro/ai/testing` exports an explicitly simulated `FakeAiPort` and a scripted
`FakeQvacRuntime`. The latter runs the real adapter's validation and numerical logic
with supplied backend responses. Neither is a production fallback. The combined
Node test uses two actual SQLite cores with MemoryTransport and the real adapter over
that scripted backend. It verifies SQL exclusion before ranking, explicit approval,
ACKed delivery, no automatic inference, persisted manifest before generation and
core-owned quote reconstruction. Node's test runner covers SQLite; Vitest covers the
adapter independently.

See the [AI harness](../../harnesses/ai/README.md) for real-run results and limitations.
Real model output does not establish retrieval quality; an annotated evaluation set
and Electron-host composition remain separate checks.
