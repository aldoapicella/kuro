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
Subsequent clean-checkout verification found that the hoist alone could still omit
the optional transitive loader. `@kuro/ai` now explicitly pins `require-asset` 1.2.2,
retaining the narrow hoist. A new detached checkout with a frozen pnpm install loaded
the actual GTE model successfully. CI now checks an actual SDK worker heartbeat with
no model load, so scripted tests cannot hide this packaging failure.
Model weights remained in the external QVAC cache. The original author's Windows
embedding-only result is separate historical evidence. Hosted checks are recorded
on the PR for its final head.
Electron application composition, physical LAN operation and retrieval/summary quality
remain separate gates; this adapter alone does not close them.

The selectable-AI transport coordinator also passed the complete workflow on macOS
arm64 with actual QVAC and two Node processes/databases (run
`2b843fd6-bbc3-4fc1-bb87-5c6949d243fa`, implementation `290c7cb`). It indexed synthetic
documents, excluded restricted/cross-space candidates, rejected stale approval tokens,
delivered explicitly approved bytes, dropped an ACK, restarted the requester and
verified immutable retry with one inbox effect. Evidence remained readable after the
requester runtime was closed; a new runtime then generated a private draft with a
literal quote. Revocation blocked a pending dispatch and installed DENIED authority
state. This run used real HyperDHT over loopback and automated approval commands;
it establishes neither physical LAN operation nor human review usability.

The same `290c7cb` scenario passed with actual QVAC on Ubuntu 24.04.4 arm64 / Node
24.19.0 in one Lima VM with two isolated Linux network namespaces (run
`87ef0191-d073-4596-9a51-1e3e06060131`, exit 0). The owner and requester used separate
SQLite state, a direct `10.77.0.1`/`10.77.0.2` veth link, strict SSH for the requester
process, no default routes and output-default-drop nftables gates. External TCP
controls failed in both namespaces before and after the complete run. Public GTE/Qwen
weights were cached and SHA-256 verified before isolation; no inference fallback was
used. The VM was resized to 8 GiB RAM and a 20 GiB disk, retaining its state. The
minimal guest also required `libatomic1` for the SDK worker's RocksDB native dependency.
This closes the virtual offline-network integration check using one shared kernel;
it is not a two-VM, physical-device or desktop-packaging result.

## Provenance

QVAC SDK and inference 0.19.0 are Apache-2.0 dependencies from `tetherto/qvac`.
The adapter was adapted from PR #4's AI implementation and migrated to the existing
KURO public contract. Vitest 2.1.9 (MIT) supports its isolated tests; the SQLite
integration uses Node's native runner. No model weights or source documents are bundled.
