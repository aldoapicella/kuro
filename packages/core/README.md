# Custody core

Status: implemented and locally tested with real SQLite, explicit simulated AI, controllable transport, and separate-process SIGKILL/reopen tests. Includes shared authority synchronization, local document policy, immutable text/index generations, the persistent computation queue, reviewed disclosure, exact-byte outbox retry, durable inbox receipt, and explicit private summary orchestration.

Exposes `AppPort` and consumes `AiPort` and `TransportPort`. Owns the single logical writer and the transaction that revalidates permissions and persists approval with exact outgoing bytes. See the [architecture](../../docs/architecture.md).

The pinned shared owner controls membership, device bindings, coarse capabilities, and recipient neighborhoods. Each custodian intersects that snapshot with its local grants and restrictions; cached shared state never grants document access by itself. See the accepted [D25 design](../../docs/decisions/D25-shared-space-authority.md).

## Public composition

```ts
import { openCore, secureIds, systemClock, SelectedTextFiles } from '@kuro/core';

const selectedFiles = new SelectedTextFiles();
const core = await openCore({
  databasePath: privateLocalDatabasePath,
  ai: qvacAdapter, transport: authenticatedTransport,
  clock: systemClock, ids: secureIds,
  sessions: hostSession, selectedFiles, pairing: hostVerifiedPairing,
  clockInitiallyTrusted: hostEstablishedClockValidity,
});
const rendererPort = core.app; // Bind only this facade through narrow IPC.
// The trusted file picker registers a path and gives the renderer its opaque token.
// The host services core.tick() regularly and supplies lifecycle barriers:
core.suspend(); // synchronous gate before admitting content callbacks
await core.resume(hostEstablishedClockValidity);
// Participants still require fresh synchronization after resume.
await core.stop();
```

Names in this example are injected host implementations, not shipped adapters. `openCore` starts the supplied transport and owns its shutdown. `tick` services authority refresh, retries, expiry and one queued computation; it never approves a review. `settled` drains already-started operations. App methods validate `AppCommands` DTOs and return typed `Result` values. Events are committed refresh hints containing IDs and revisions only.

Selected file tokens bind the selected device/inode and verify the opened descriptor. Source bytes, including BOM, CRLF and Unicode, remain unchanged; paths and source hashes stay local. Blocks are at most 1,500 UTF-8 bytes and the demonstration corpus has at most 40 blocks. Oversized snapshots reject; partial ingestion and sources excluded from local reading are explicit. Generations complete only for their current authorized set. ACL changes queue a new generation; pending generations cannot silently report complete coverage.

## Persistence and recovery

Migration 1 creates authority/cache/policy/publication/recovery state; migration 2 creates documents, FTS5, vectors, workflow, inbox/outbox and summary state. There is no migration from the Python reference. One private `node:sqlite` connection uses prepared statements, foreign keys, short `BEGIN IMMEDIATE` transactions, `synchronous=FULL` and the rollback journal. Do not share a database between core instances or place it on a synchronized/network filesystem. Transport encryption does not encrypt SQLite.

Restart marks participant positive caches stale, preserves high-water marks, reconciles interrupted work and requires fresh synchronization. Committed bytes and inbox deduplication survive. Previously attempted deliveries may retry only after revalidation; cancelled approvals do not revive. Interrupted indexes become failed and can be rebuilt through `setIndexProfile`. Cancellation retains the execution slot until the provider settles. An unresponsive native adapter requires its host/worker recovery; the core cannot forcibly terminate an injected SDK object.

`replaceAuthority` requires verified setup for a new space/key namespace. An owner host provisions a different protected identity and reopens the core first. Old namespaces remain permanent tombstones with counters and provenance retained. Local snapshots/restrictions are copied, while new indexing/review are required. No old approvals, inboxes or summary results move to the new namespace.

## Validation

```sh
pnpm test:core
pnpm --filter @kuro/core-harness harness -- --state /absolute/private/test-state
```

See the [manual harness](../../harnesses/core/README.md) and [handoff/evidence map](../../docs/development/core-transport-handoff.md). The `@kuro/core/testing` export contains only named simulations: `FakeAiPort`, `FakeClock`, `FakeIds`, `FakeSession`, `FakePairing` and `MemorySelectedFiles`. They are never automatic fallbacks. These tests do not imply real QVAC inference or Electron compatibility.
