# KURO engineering baseline

Baseline version: **0.1**. Status: **shared implementation specification**. This document adds integration conventions to the [architecture](../architecture.md); it does not claim the application or its adapters exist. At adoption, the repository contains documentation and a Python design reference, with application packages still planned.

The purpose is to let each module run and evolve independently while remaining compatible at integration. The tracked [AGENTS.md](../../AGENTS.md) requires implementation agents to follow this baseline. Read [CONTRIBUTING.md](../../CONTRIBUTING.md) for the contribution workflow.

## 1. One product flow

Each installation can act as custodian or requester for different requests. These are contextual responsibilities, not separate applications or profession-specific roles.

1. The custodian imports immutable text snapshots and builds a local QVAC embedding index.
2. An authenticated requester sends a bounded question to an explicitly selected custodian.
3. The custodian authorizes the request and filters eligible source rows before ranking.
4. A local reviewer selects and approves exact passages, references, conditions, and recipient.
5. The core commits approval with the exact outgoing bytes and delivers them through Pear.
6. The requester persists received evidence before acknowledgment. Evidence is readable independently of a model.
7. A separate local action may run QVAC synthesis over permitted received evidence. The result remains a private derivative with complete provenance.

Original files, private indexes, full ACLs, local paths, and original-file hashes do not cross the peer protocol. The MVP does not forward received evidence or summaries to a third participant.

## 2. Ownership and dependency direction

| Module | Owns | Integrates through | Must not own |
| --- | --- | --- | --- |
| `packages/contracts/` | Public types, runtime schemas, protocol encoding, constants, errors, compatibility fixtures | Public package exports | Database, Electron, QVAC, or Pear dependencies |
| `packages/core/` | Policy, sessions, versions, SQLite migrations, index persistence, retrieval orchestration, queue, review, inbox/outbox, manifests | Exposes `AppPort`; consumes `AiPort`, `TransportPort`, and injected local infrastructure | Rendering, direct SDK calls, independent network protocol copies |
| `packages/ai/` | Local QVAC worker, embedding calculations, ranking calculations, exact context preparation, generation, output validation | Implements `AiPort` | SQL access, authorization, disclosure, persistent job scheduling |
| `packages/transport/` | Pear/HyperDHT worker, authenticated connections, framing, bounded buffers, lifecycle | Implements `TransportPort` | Corpus access, policy decisions, payload reconstruction, application ACK decisions |
| `apps/desktop/` | Electron lifecycle, composition, OS adapters, preload, renderer, packaging | Binds adapters to the core; renderer consumes `AppPort` | Duplicate domain state machines or renderer-side access control as the security boundary |
| `harnesses/*/` | Executable, independent module demonstrations and diagnostics | The same public contracts as real composition | Production fallbacks disguised as simulations |

`contracts` is a dependency of each module and depends on none of them. Core does not import AI, transport, or desktop implementations. The desktop composition root selects and injects implementations. Internal core storage/policy/retrieval interfaces remain internal unless another module actually needs them.

The core contributor coordinates initial contracts and their conformance fixtures. AI and desktop consumers can propose changes; ownership is responsibility for compatibility, not exclusive permission to edit. Numerical `rankAllowed` work belongs behind `AiPort`; core retrieval owns the authorized SQL candidate set, literal matching, fusion, and provenance. There is one implementation of each responsibility.

## 3. Shared bootstrap checkpoint

The first implementation checkpoint establishes the contract package and minimal runnable workspace **before** substantial consumer code. Later tasks reuse it. If this checkpoint already exists, extend it instead of scaffolding a second workspace.

Required checkpoint artifacts:

- Public `AppPort`, `AiPort`, `TransportPort`, DTOs, validators, errors, states, capability negotiation, and all five wire-message schemas.
- Synthetic valid and invalid fixtures, exact encoded wire bytes/digests, and shared conformance tests. Store cross-module fixtures under `fixtures/contracts/v1/` once created.
- One root package manifest, one application package-manager lockfile, one TypeScript configuration family, and a recorded runtime compatibility decision under `docs/decisions/`.
- Commands for type checking, contract tests, and each independently runnable harness. Publish the actual commands; do not document commands that have not run.

Use TypeScript with strict checking and ESM for application packages. Contracts expose JSON-compatible DTOs; `Uint8Array` is permitted at host/worker transport boundaries, not as a JSON wire value. No implicit SDK objects, `any` escape hatches, or cross-package internal imports. Select exact runtime and dependency versions from compatibility evidence and lock them once. Do not infer Electron's SQLite/FTS5 support from terminal Node.

If no workspace exists, the contributor publishing the contract checkpoint may create this minimal root configuration. Afterward, desktop integration coordinates root configuration and packaging changes. Module tasks add their own package scripts and dependencies without replacing the root manifest, changing package managers, or creating nested application lockfiles. Native worker dependencies may need separate build artifacts; document a demonstrated toolchain requirement before making an exception.

Publish the checkpoint as a separate commit/PR. Consumers use the same checkpoint and fixtures; they do not wait for completed AI, UI, or P2P implementations. Subsequent contract changes include the reason, affected consumers, compatibility treatment, and conformance results. Reject unsupported protocol versions rather than silently guessing their meaning.

## 4. Public interface semantics

The following names and responsibilities are the baseline for the first contract checkpoint. Freeze complete argument/result types and runtime schemas in `packages/contracts/`; these prose entries are not a claim that callable interfaces already exist.

| Port | Operations | Required behavior |
| --- | --- | --- |
| `AppPort` | `importText`, `submitQuestion`, `getState`, `listReviews`, `getReview`, `approveDraft`, `getEvidence`, `requestLocalSummary`, `cancelJob`, `subscribe` | Commands return a typed result or durable operation ID. Snapshots are authoritative; events prompt refresh. Approval supplies draft ID, expected revision, and reviewed-view digest, never replacement content. |
| `AiPort` | `getCapabilities`, `embedBlocks`, `rankAllowed`, `prepareSummary`, `runPreparedSummary`, `cancel` | Identified and bounded inputs/results; explicit profile and provenance; cancellation by job ID. Preparation returns exact model-visible context, dependency manifest, budget accounting, and a digest. Execution consumes that preparation without adding context. |
| `TransportPort` | `start`, `stop`, `send`, `subscribe` | Send a specified key and exact bytes. Inbound events supply authenticated remote key and bounded bytes. A resolved send is not an application acknowledgment. |

Local administration uses separately typed commands with the same core authorization rules. No generic string-based dispatcher is exposed to peers. The host binds an authenticated local session to `AppPort`; the renderer cannot select an arbitrary acting identity. `importText` accepts an opaque, bounded import selection registered by the trusted host, never a renderer-controlled arbitrary path. The core reads through an injected import source and verifies the selected snapshot.

Local infrastructure dependencies include storage, clock, IDs, secret storage, and selected-file access. Publish the minimal host-facing interfaces needed for composition with the contract checkpoint. Keep SQL connections and native file handles internal. Test implementations are named `FakeAiPort`, `MemoryTransport`, `FakeClock`, and `InMemorySecretStore` or equally explicit names.

Public results distinguish success, denied, stale, unavailable, cancelled, and failed states. Baseline local error codes include `ACCESS_DENIED`, `STALE_REVISION`, `MODEL_UNAVAILABLE`, `CAPACITY_EXCEEDED`, `EXPIRED`, `PEER_OFFLINE`, `INVALID_MESSAGE`, `CANCELLED`, `STORAGE_FAILURE`, and `INVALID_MODEL_OUTPUT`. Freeze retryability and state consequences in contracts. Peer-visible `CLOSED` responses are generic and do not expose these detailed local diagnostics.

Core events identify the entity and committed revision, omit confidential payloads, and are emitted after commit. Consumers can always reload an authorized snapshot after startup or missed events. Do not infer persistence from a renderer notification or native-worker callback.

## 5. Shared representations and protocol

| Concern | Baseline convention |
| --- | --- |
| JSON | UTF-8, strict discriminated schemas, unknown fields rejected, bounded strings/arrays and nesting. Reject malformed UTF-8 and ambiguous duplicate object keys. |
| IDs | Opaque strings, generated locally; request/response IDs contain at least 128 bits of cryptographic randomness. IDs and display names do not prove identity. |
| Identity | Authenticated transport keys map to local member identities; several paired device keys share one identity quota. Freeze key encoding in contracts using the actual transport library. Never trust a body `sender` field. |
| References | Every passage identifies origin, document, version, and span. Local storage additionally keys by space. Context aliases map to complete references; do not reuse ambiguous span IDs across sources. |
| Text offsets | Zero-based, half-open UTF-8 byte offsets into the immutable imported snapshot. For MVP valid UTF-8 text, preserve source bytes: no newline or Unicode normalization. Test multibyte characters, emoji, and CRLF. Future extraction needs an explicit source mapping/version. |
| Revisions | Nonnegative safe integers: separate `policyEpoch`, `corpusRevision`, `indexGeneration`, and entity revision. Mutations compare expected revisions; never replace one with another. |
| Time | Internal wall-clock timestamps are integer milliseconds since Unix epoch; durations carry explicit units. Inject wall and monotonic clocks. Protocol request validity uses bounded `ttlSeconds` from local admission; duplicates never reset expiry. Restart/clock rollback must not restore expired rights. |
| Framing | Four-byte unsigned big-endian body length followed by at most 32,768 bytes of UTF-8 JSON. Validate length before allocation; handle partial and combined frames with bounded buffering. The prefix is outside the body limit. |
| Request bounds | Question at most 2,048 UTF-8 bytes; TTL is a positive integer no greater than 86,400 seconds. No remote paths, SQL, tools, model commands, or permission mutations. |
| Digests | SHA-256. Canonical request digests cover all validated fields, including version, type, scope, and TTL; pin serialization with fixtures. Delivery/ACK digests cover the exact serialized JSON body, excluding the framing prefix. Hashes detect identity/content conflicts; they do not prove a document's truth. |
| Embeddings | Identified Float32 vectors plus model ID/checksum, dimension, normalization, and segmentation version. Validate dimension, finite values, and nonzero norm. Activate only complete compatible index generations. |

The contract checkpoint must fully define `SEARCH_REQUEST`, `RECEIVED`, `APPROVED_RESPONSE`, `RESPONSE_ACK`, and `CLOSED` before writing their providers. All messages carry protocol version and a discriminated type. Check response/ACK correlation against the authenticated peer and persisted request/delivery scope, not just an ID. Bind opaque space aliases to `(peerKey, spaceAlias)` locally.

Delivery conditions require an explicit local-processing permission and bounded validity whose receiver-side meaning is defined in the schema. Missing or unsupported conditions do not enable synthesis. Store first-receipt validity once; repeats cannot extend it. Absolute source validity, if present, can only narrow that window. Forwarding remains disabled. The exact field encoding, sizes, and expiration calculations belong in the shared schema and golden fixtures, not divergent adapter implementations.

Use separate request, delivery, and synthesis state enums, as in architecture section 7. `RECEIVED` follows durable admission; `RESPONSE_ACK` follows durable inbox receipt; `DRAFT` is a generated result requiring review. Neither acknowledgment means the LLM ran or that a human accepted the result. Local views distinguish empty results, incomplete coverage, denied access, and failure; the external protocol does not reveal why a custodian withheld evidence.

## 6. Required invariants and acceptance evidence

| ID | Requirement | Minimum meaningful evidence |
| --- | --- | --- |
| B01 | Local QVAC inference only. No model inference in the transport, cloud, or automatically selected third peer. | Real-adapter validation when available; unavailable AI leaves evidence readable. Simulations are explicitly labeled. |
| B02 | Default deny: verified identity, active membership, explicit action grant, scope, document restriction, and validity. `manage` alone gives no content rights. | Deny cases for every missing predicate, cross-space identity/alias attempts, removed members, and unauthorized grant changes. |
| B03 | SQL authorization precedes both vector ranking and literal retrieval; core rechecks before materializing text. | Restricted sentinel documents/vectors never reach the AI spy, ranking, result, review, or peer payload. No retrieve-then-redact implementation. |
| B04 | One SQLite writer commits review revalidation, approval, exact bytes, digest, dependencies, and outbox entry atomically. | Inject failure before commit and reopen the actual database: either all authorized output exists or none does. No human/model/network waits inside transactions. |
| B05 | Dispatch revalidates source/recipient rights, revisions, and expiry before each attempt; retries use persisted bytes. | Revoke before dispatch, change source after review, lose ACK, restart after commit, and compare retried bytes exactly. Revocation after the send authorization point may not intercept transit. |
| B06 | Durable admission and receipt precede acknowledgments; effects are idempotent. | Storage failure produces no ACK; identical replay has no duplicate work/evidence; same peer/ID with changed digest is rejected. Test separate databases and process restarts. |
| B07 | Received evidence is useful without synthesis. Only an explicit permitted local action starts it. | No LLM call on receipt/ACK/read; model-unavailable and failed-synthesis cases preserve authorized evidence access. |
| B08 | Before generation, persist the exact prepared context and all dependencies, including question and uncited passages. | Permission change before execution blocks it; context mismatch and late results are rejected. Core attaches provenance, AI checks structured output, and quotes are assembled from received text. |
| B09 | One persistent core queue and one active QVAC operation per device. AI adds an execution guard, not another queue. | Cancellation/expiry discard late results; linked device keys share quotas; indexing yields; round-robin identity fairness survives recovery. |
| B10 | Current access and delivery conditions apply to review, display, synthesis, and future dispatch. | Expiry, stale revisions, missing conditions, and clock rollback fail closed. No claims of instant offline revocation or recall of copies. |
| B11 | Private state and secrets stay local and outside distributed code. | Secret-store failure is explicit; no production plaintext secret fallback, sensitive default logs, or real data in fixtures. Electron secret storage must reject unavailable/basic-text providers. |
| B12 | Real providers and test doubles share observable contracts. | Run the same applicable conformance tests against both; report simulated, real-process, and physical cross-device evidence separately. |

Default demonstration bounds remain: one active operation, at most five waiting jobs, at most one pending request per authenticated member identity across linked devices, up to 120 seconds of computation per task, and small indexing batches. Reviewer waiting time is separate from computation; persist and bound review retention. Use eight vector and four literal candidates, fuse by rank, and select at most six blocks within the entire response-body limit. The initial corpus target is 40 blocks. Summary context is at most 4,096 tokens including instructions/question/schema and at most 512 output tokens; verify the chosen backend's accounting and reserve output capacity rather than assuming extra space.

Threshold changes are shared configuration changes with tests and measurements. All operations on one installation share the device budget even when it is custodian and requester simultaneously. The unopened NVIDIA P3450 is not a required runtime target until compatibility is demonstrated.

## 7. Independent iteration and integration

| Harness | Independent inputs | Must demonstrate |
| --- | --- | --- |
| Core | Two core instances, separate databases/identities, deterministic AI, controllable transport/clock | Import → request → permitted retrieval → manual review → approved delivery → durable ACK; restart, loss, replay, denial, optional summary scheduling |
| AI | Synthetic permitted vectors/passages, prepared manifests, resource limits | Real local QVAC loading, embeddings/ranking, preparation/execution consistency, cancellation, invalid-output handling, no hidden context |
| Desktop | Contract-conforming in-memory `AppPort` with scripted states | All user flows, stale review handling, unavailable models/peers, state refresh, escaped text, narrow preload |

Fakes live in clearly named testing exports or harness packages. They implement the current contracts and are selected explicitly. A real adapter failure never silently swaps to a fake. Shared fixtures cover authorized, restricted, cross-space, stale-version, oversized, duplicate, and insufficient-evidence cases.

Merge order follows dependencies, not completion of whole modules:

1. Shared bootstrap and contract conformance checkpoint.
2. Independent module increments that keep those contracts green.
3. Desktop composition with real core and simulated adapters.
4. Replace each simulation with its real conforming adapter.
5. Validate real QVAC and Pear together, then fresh startup/reconnection on an isolated LAN with internet egress blocked and intended bootstrap connectivity available.

Real transport must also have an independently runnable two-process check. Loopback is useful evidence, but it is not proof of two-device offline networking. Real inference tests require actual models and compatible hardware. Complete all available checks and list the specific external verification still pending; do not replace it with a simulated success.

## 8. Change and handoff rules

- Start from the shared contract checkpoint. Use separate worktrees/branches for simultaneous edits; isolate runtime data for every node/harness run. Do not force-push, replace another branch's files, or solve conflicts by weakening tests.
- Changes that preserve public contracts are independent module work. Changes to DTOs, schemas, state/event meaning, shared limits, dependencies at root, or cross-module fixtures need a small integration change first. Add an adapter or preserve old consumers until migration is included.
- Record decisions affecting runtime compatibility, serialization, storage, or security in `docs/decisions/` with rationale and observed validation. This baseline resolves previously open integration details such as offsets and framing; later changes must update it and consumers together.
- Handoffs include commit, public exports, exact commands and outcomes, configuration, migration behavior, simulated dependencies, and unresolved adapter/device checks. Document actual implementation status in each affected package README.
- Update the development graph after code changes, keep generated output ignored, and declare incorporated third-party material in README provenance. Personal work assignments stay in ignored local notes.

The Python reference suite remains useful design evidence. It is not the application security implementation, transport, scheduler, QVAC adapter, or substitute for their tests.
