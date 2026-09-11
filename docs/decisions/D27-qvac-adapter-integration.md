# D27 — QVAC adapter integration

Status: accepted implementation decision, September 10, 2026.

## Decision

Integrate the AI implementation with the existing [D26 contract checkpoint](D26-runtime-and-contract-checkpoint.md)
and pnpm workspace. Do not replace core/transport contracts, introduce a second npm
lockfile or redefine public errors. SDK/inference 0.19.0 are pinned in the single root
lockfile. The SDK's model registry supplies checksum identities.

`@kuro/ai` implements current identified embeddings/ranking and complete prepared
summaries. Core remains the authorization authority and single persistent scheduler.
Hosts compose one runtime per device and retain a separate close handle. A failed
native cancellation request does not release its operation slot or accept late output.
Cold model-load requests are tracked too; cancellation prevents later compute stages.

The adapter normalizes GTE vectors to unit Float32 values and rejects incompatible
profile metadata. This declared profile is distinct from the original PR's raw-vector
profile; index profile changes use core's existing staged-generation mechanism. No
storage or contract migration is introduced.

Summary preparation uses the shared exact JSON envelope and digest over all metadata,
sources and omissions. UTF-8 bytes provide a conservative context bound and the entire
512-token output allocation is reserved within 4096. The provider may still reject a
context; that is a typed failure. Execution never silently rewrites the persisted
prompt. Raw model JSON cannot override trusted correlation metadata, and core resolves
aliases to literal delivered passages. There is no automatic format-repair prompt. Token-limit or cancelled completions cannot
become valid summaries. QVAC 0.19.0 documents an omitted completion stop reason as
natural EOS in its bundled `completion-stop-reason` example; the SDK seam normalizes
only that documented case, while unknown values fail closed.

## Validation boundary

The public-port integration uses two real SQLite cores, MemoryTransport, and the real
AI adapter with a scripted backend. It checks restricted/cross-space sentinels before
ranking, explicit stored-view approval, durable delivery, no generation on receipt or
read, manifest persistence before provider completion and quote reconstruction. It is
not evidence of model inference. Existing contract/core/transport/Python suites stay
in the combined checks, with an additional independent AI harness.

Fresh local validation on September 10, 2026 passed:

- Frozen pnpm install, strict workspace typecheck and build.
- 119 TypeScript tests: contracts 8, core 64, transport 13, AI 33, and one combined
  SQLite/core/AI test. The separate Python reference suite passed 16 tests.
- Independent scripted AI harness, SQLite/FTS5/reopen probe, and actual HyperDHT
  two-process smoke (five D25 messages).
- Actual QVAC 0.19.0 on macOS arm64 / Node 24.19.0: GTE produced a 1024-dimensional
  embedding and Qwen produced a naturally completed answer citing P1. For the
  synthetic passage that payment had not been approved, the claim was “The payment
  has not been approved.” The full prepared JSON measured 730 UTF-8 bytes, with
  512 output tokens reserved. Both registry model checksums were pinned, and the
  runtime closed normally. No scripted backend supplied this result.

The real run required the workspace's targeted `require-asset` hoist and Homebrew
OpenSSL 3 (3.6.4 in this run), which the pinned macOS native addon links directly.
Model weights remained in the external QVAC cache. The original author's Windows
embedding-only result is separate historical evidence. Hosted checks are recorded
on the PR for its final head.
Electron application composition, physical LAN operation and retrieval/summary quality
remain separate gates; this adapter alone does not close them.

## Provenance

QVAC SDK and inference 0.19.0 are Apache-2.0 dependencies from `tetherto/qvac`.
The adapter was adapted from PR #4's AI implementation and migrated to the existing
KURO public contract. Vitest 2.1.9 (MIT) supports its isolated tests; the SQLite
integration uses Node's native runner. No model weights or source documents are bundled.
