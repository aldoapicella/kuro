# Core and transport implementation handoff

The TypeScript custody workflow is implemented with real local SQLite: authenticated admission, authorization before ranking, stored human review, atomic approval/outbox, exact-byte retries, durable inbox before ACK, and optional private summary manifests. Shared authority follows D25, including original-send leases and explicit namespace recovery. The transport uses the actual HyperDHT stack in a Node worker. The manual core harness deliberately uses simulated AI and transport.

This is a module handoff. Standalone QVAC embedding/generation is now verified by the [AI harness](../../harnesses/ai/README.md). The complete host workflow with real QVAC, Electron composition, Bare/Pear packaging, and physical two-device offline-LAN operation remain separate integration gates. No simulation automatically substitutes for an unavailable real adapter.

## Install and run

Use Node **24.19.0** and pnpm **11.19.0** from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm probe:host
pnpm test:reference
pnpm --filter @kuro/transport-harness smoke
pnpm --filter @kuro/core-harness harness -- --state /tmp/kuro-core-demo
```

The harness state directory must initially be empty. Follow the [core harness commands](../../harnesses/core/README.md) for explicit review and approval, lost ACK, restart, revocation, authority expiry, and model-free evidence reading. `init` never approves evidence. `approve` requires the printed draft ID, revision, and view digest. The harness's `restart` is an orderly close/reopen; separate automated tests perform real process termination.

`pnpm build` emits JavaScript, declarations, and source maps under ignored `dist/`. Public workspace exports currently resolve TypeScript source for `tsx` development. Desktop bundling must consume these exports and package the worker explicitly. QVAC dependencies and a conforming AI adapter are now provided by `@kuro/ai`; Electron host composition remains pending.

## Public integration points

| Package | Public entry point and responsibility |
| --- | --- |
| `@kuro/contracts` | Strict `AppCommands`/`AppPort`, `AiPort`, `TransportPort`, host interfaces, all seven wire messages, canonical digests, schemas, limits, states, typed errors. |
| `@kuro/core` | `openCore`, `CustodyCore`, `CoreOptions`, `SelectedTextFiles`, `systemClock`, `secureIds`. Only `core.app` belongs behind renderer IPC. |
| `@kuro/core/testing` | Named deterministic `FakeAiPort`, clocks, IDs, session/pairing, and selected-file simulations. |
| `@kuro/ai` | `createAiAdapter` provides an `AiPort` and separate host close handle; pinned profiles and explicit scripted testing exports. See [D27](../decisions/D27-qvac-adapter-integration.md). |
| `@kuro/transport` | `HyperDhtTransport`, framing utilities, and explicitly simulated `MemoryTransport`/`MemoryNetwork`; shared provider conformance helper. |

See the [core composition example](../../packages/core/README.md) and [D26 contract decision](../decisions/D26-runtime-and-contract-checkpoint.md). Host dependencies bind local identity, verified one-time pairing selections, bounded selected files, clock validity, and protected identity storage. The renderer cannot choose the acting identity or inject a document path. Lifecycle controls remain separate from `AppPort`.

The host calls `tick()` regularly to service synchronization, expiry, retries, and the one persistent queue. `settled()` waits for work already started; it does not approve a review or start all queued jobs. `suspend()` closes the authorization gate synchronously. `resume(clockIsTrusted)` marks participant caches stale before allowing fresh synchronization; a positive response to a request sent in a previous lifecycle epoch is rejected. An owner also loses active work across this barrier. A host that cannot establish clock validity must keep the gate closed.

The AI adapter receives identified authorized blocks/vectors, never a database handle or policy authority. Core validates compatible finite Float32 vectors and complete summary preparations. It persists the exact preparation before execution, checks all context dependencies, reconstructs literal quotes from delivered passages, and labels prose as a draft requiring semantic review. Adapter cancellation may be advisory: the core discards late results and retains the single execution slot until the provider settles. A stuck native operation requires host/worker recovery.

`replaceAuthority` is an additive local contract checkpoint. A verified setup token must identify a new space and different authority key. Owner recovery requires reopening with the new protected transport identity first. The operation retains the old tombstone/counters and copies local snapshot restrictions, while requiring new indexing and review. No old approval, inbox item, or summary moves to the new namespace.

## Storage, bounds, and recovery

Migration 1 contains authority state, local policy, recipient projections, counter high-water marks, pending synchronization and durable publications. Migration 2 contains immutable documents/versions/spans, FTS5, index generations/vectors, requests/jobs/reviews, approvals/outbox, inbox/received spans, and summary manifests/results. There is no migration from the Python reference.

The private `Store` is the single SQLite writer. It uses prepared statements, foreign keys, short synchronous transactions, rollback journaling and `synchronous=FULL`. Database access never crosses a public port. Use a private local directory and one core instance per database. This storage is not encrypted by transport encryption.

Limits are exported through contracts: 32 stored space namespaces including recovery tombstones; 262,144-byte text snapshots; 40 indexed blocks of at most 1,500 UTF-8 bytes; batches of four; five waiting jobs; one pending request per authenticated identity across its linked keys; one active computation; a 120,000 ms computation budget; and bounded 24-hour request/review retention. The wire body limit is 32,768 bytes. The complete authorized index set is distinguished from excluded or partially ingested source coverage. Profile, corpus or ACL changes stage a new generation and invalidate affected pending work.

Participant caches are stale after restart. High-water marks, accepted bytes and deduplication survive; outstanding authority-sync correlations do not cross process/lifecycle epochs. D25 validity is at most 900,000 ms from the original sync request send with both wall and monotonic deadlines, not response arrival. A same-policy renewal before expiry preserves work; a renewal after an unnoticed lapse first invalidates expired work. Denial, policy change and expiry cancel pending outgoing questions as well as inbound retrieval, releasing their identity quota. Late correlated replies and later regrants cannot revive cancelled requests or approvals. Lifecycle staleness alone permits an unchanged-policy outgoing question to resume after fresh authorization before its prior lease expires, with its original bytes and TTL. A stale cache still expires at its persisted wall deadline; an old process monotonic deadline is never compared across restart. Dispatch and first receipt recheck the request after authorization applies scheduled policy changes.

Interrupted running jobs are cancelled and their request/index/summary states are reconciled. Interrupted indexes can be rebuilt through `setIndexProfile`. A committed approval never gets reconstructed from current source text. An already attempted delivery may retry its original bytes only after revalidation. Receipt deduplication commits before ACK; transport send acceptance is never treated as an ACK.

## Acceptance evidence

Tests use synthetic fixtures and actual SQLite files. The core harness uses two cores and two databases in one process. The crash suite kills a child with `SIGKILL` and inspects/reopens the database in another process; this is process-crash evidence, not a physical power-loss test.

Local results on September 10, 2026:

| Check | Result |
| --- | --- |
| Frozen workspace install | Passed; lockfile unchanged. |
| Strict typecheck and declaration/JavaScript build | Passed. |
| Contract tests | 8 passed. |
| Core tests | 64 passed, including 26 authority cases, six separate-process SIGKILL cases, two actual manual-CLI tests and seven additional request-cancellation/recovery cases. |
| Transport tests | 13 passed, including concurrent identity creation, overlapping shutdown/restart, simultaneous authenticated dials and delayed/lost-message conformance. |
| Python reference regression | 16 passed, independently of the TypeScript suites. |
| Real HyperDHT smoke | Passed: five authenticated D25 protocol messages, process relaunch, exact-byte replay. |
| Process-scoped local-only egress smoke | Passed with the same five-message exchange; an external TCP connection control returned `EPERM`. |
| SQLite host probe | Node 24.19.0 / SQLite 3.53.3, FTS5, foreign keys and persistent reopen passed on macOS arm64 and both Ubuntu arm64 guests. |
| Virtual custody workflow | Passed with the implementation incorporated in `4d59f7e`, using one Ubuntu VM using two isolated Linux network namespaces and a direct veth link. Separate peer processes/databases, output-default-drop gates and failed external TCP controls. |
| Two Lima guests over user-v2 | Not passed: clean runs timed out at initial authority synchronization or after requester relaunch. A synchronized direct UDP echo passed; these failures do not establish a generic UDP outage. |

Initial validation exposed and corrected D25 parser round trips, lifecycle/expiry renewal races, interrupted-job state reconciliation, selected-file replacement boundaries, summary manifest rollback, and transport startup cancellation. Review additionally required atomic host secret creation and serialized stop/start. Extended testing exposed intermittent same-key reconnection delivery failures, also seen in hosted CI. The retained regressions now pass with the SDK connection pool and bounded encrypted-stream flush/reconnect handling. Fresh Linux/macOS push and pull-request CI passed on transport commit `29a93a4`; final hosted evidence is recorded on the implementation PR. The separate Lima user-v2 profile remains unsuccessful and must not be described as a two-VM pass. None of these results closes the external gates below.

| Baseline | Observable evidence |
| --- | --- |
| B01 | Explicit simulated AI; no model call on receipt/read and unavailable generation preserves evidence. Real-model smoke evidence is recorded separately in [D27](../decisions/D27-qvac-adapter-integration.md); host composition remains pending. |
| B02, B13 | `authority.test.ts`: missing predicates, membership/grant/capability intersection, manage versus owner, local ACL restrictions, verified pinning, namespace recovery. |
| B03 | `workflow.test.ts`: restricted and cross-space sentinel text/vectors never enter the AI ranker, review or delivery. SQL predicates precede candidate materialization. |
| B04 | `workflow.test.ts`, `crash.test.ts`: rollback/concurrent approval and SIGKILL before/after commit preserve atomic approval/dependencies/outbox. |
| B05 | `lifecycle.test.ts`, `workflow.test.ts`, `harness.test.ts`: source change/revocation before dispatch, stale review rejection, lost ACK and exact persisted-byte retry, denial/expiry cancellation, late reply rejection and fresh approval after regrant. |
| B06 | `workflow.test.ts`, `crash.test.ts`: durable admission and receipt, no ACK on storage failure, changed-byte replay rejection, authenticated wrong-peer ACK rejection, independent reopen. |
| B07, B08 | `summary.test.ts`, `workflow.test.ts`: explicit processing conditions, exact full manifests, hidden-context rejection, manifest rollback before generation, lifecycle/revocation late-result discard, literal quote reconstruction and readable evidence without AI. |
| B09 | `scheduler.test.ts`, `lifecycle.test.ts`, `crash.test.ts`: yielding batches, linked-key quotas, round-robin fairness, cancellation holds the slot, late-result discard, interrupted-job reconciliation. |
| B10, B14 | Authority/lifecycle tests: original dual deadlines, delayed first response, rollback, denial, expiry, stale epoch/correlation rejection, resume-queued disclosure gate, unchanged versus expired renewal. |
| B11 | Transport secret-store tests reject unavailable/basic-text storage; selected-file tests bind device/inode and reject link/replacement escapes. Public errors and remote closures omit document content and local denial reasons. |
| B12 | One applicable transport conformance helper is run through MemoryTransport and separate real HyperDHT peer processes. Physical-device and host packaging results are recorded separately. |

| D25 criterion | Evidence and boundary |
| --- | --- |
| 1–2 | Owner enrollment, direct projection install, explicit local grants and document ACL, non-owner management denial. |
| 3 | Wrong origin/recipient/alias/space/correlation, digest, duplicate identities and unsupported projection rejection. |
| 4–5 | Byte-identical durable replay, obsolete publication closure, original-send deadlines, high-water rollback/conflict rejection, valid unchanged renewal and late renewal invalidation. |
| 6 | SQLite install failure leaves permissions unchanged; revoked paired recipient gets correlated DENIED; unknown peer gets generic CLOSED. |
| 7 | Outage at the original lease boundary, restart/suspend/clock staleness, queued-dispatch barrier, shortened scheduled-expiry lease, discarded old sync correlations. |
| 8 | Explicit new authority namespace, retained tombstones/counters, copied local restrictions, no revived old approval. |
| 9 | Complete recipient neighborhoods replace rather than merge; projection/key and stored-namespace limits fail closed. |
| 10 | Real Node HyperDHT processes exchange authenticated D25 messages. Bare/Pear host packaging and physical offline LAN remain unverified. |

The successful virtual run uses two network namespaces in one Ubuntu 24.04.4 arm64 VM, with peer addresses `10.77.0.1` and `10.77.0.2`, no default routes, and namespace-local nftables gates. The automated fixture explicitly rejects wrong approval revision/digest, approves the printed synthetic view, drops ACK, relaunches the requester with the same seed/database, verifies immutable retry and one inbox effect, reads evidence with AI unavailable, explicitly runs simulated summary, blocks a revoked pending response, and installs a correlated DENIED projection. Its clean run ID is `b3c6a477-9da4-484d-acb4-de710d6edf50`. This is virtual-network evidence using one kernel; its approval is an explicit automated test command, not a human usability test. See the [reproduction procedure](../../harnesses/transport/README.md#one-vm-with-isolated-peer-network-namespaces).

The Python reference suite is separate regression evidence; it does not prove the TypeScript authorization implementation or D25. Scoped GitHub Actions define Linux/macOS validation, but a local pass does not establish a hosted CI result.

## External gates and next checks

1. **Electron host:** provide the selected Electron version/build. Run `scripts/probe-host.mjs` in that application's main-process runtime and record `process.versions`, SQLite, FTS5, foreign keys and disk reopen. Repeat the core lifecycle tests through the actual host suspend/resume barrier. Verify the OS secret adapter reports protected storage, rejects unavailable/Linux `basic_text`, and implements `createIfAbsent` atomically across processes with durable winning bytes. Terminal Node alone cannot close this gate.
2. **QVAC application integration:** the conforming adapter and combined SQLite/sentinel/manifest test now exist in `packages/ai`. That integration test uses a scripted backend. Run the manual request → review → explicit approval → evidence → explicit summary sequence through the actual host and QVAC models. Keep evidence readable with the model unloaded. The independent real-model harness and its results are documented in [D27](../decisions/D27-qvac-adapter-integration.md).
3. **Bare/Pear runtime:** select and provide the intended host/toolchain and worker bridge. Package the HyperDHT worker through that runtime's verified APIs, keep authenticated key/byte semantics and bounded lifecycle behavior, and run the shared transport conformance suite. The current worker imports Node worker threads and is not a Bare package.
4. **Physical offline LAN:** provide a second configured device and control of the intended LAN's external egress. Use an isolated HyperDHT bootstrap plus a persistent routing node, explicit known peer keys, and no public bootstrap fallback. Start both peers fresh with WAN disconnected while allowing their LAN/bootstrap ports. Exchange `SPACE_STATE_REQUEST` and the correlated authenticated projection, run the core evidence flow, stop/restart the recipient with the same protected identity, and verify exact retry/one inbox effect. Record devices, runtime versions, bootstrap/router addresses, interface/firewall policy, and failed external-connection control. Repeat after disconnect/reconnect. The bootstrap/peer runner and command protocol are documented in the [transport harness](../../harnesses/transport/README.md).

## Runtime and provenance

The local host probe on September 10, 2026 uses macOS arm64, Node 24.19.0 and SQLite 3.53.3; FTS5, foreign-key enforcement and persistent reopen passed. No Electron runtime result is inferred. Native transport modules come through pinned HyperDHT 6.34.0; the adapter uses supported known-key connection and authenticated `remotePublicKey` APIs. Test seeds are synthetic and explicitly ephemeral.

Zod 4.6.1, Ajv 8.20.0 and `@noble/hashes` 2.4.0 supply validation and hashing. TypeScript 5.9.3, tsx 4.23.13 and Node types 24.13.4 support development. See [D26](../decisions/D26-runtime-and-contract-checkpoint.md) and the root [provenance declaration](../../README.md#provenance-and-dependencies) for licenses and origins. No real documents, production credentials, model weights, databases, or generated graphs are tracked.
