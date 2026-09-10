# Shared contracts

Status: the initial callable contract checkpoint is implemented. `@kuro/contracts` exports strict `AppPort`, `AiPort`, `TransportPort`, host dependency interfaces, local command schemas, model/context validators, typed errors/states, and all seven wire message types and validators. D25 runtime providers and custody behavior are implemented and tested separately in the core.

This package must not depend on Electron, SQLite, Pear, or QVAC. Real adapters and test doubles must satisfy the same contracts. See the [architecture](../../docs/architecture.md) for boundaries and invariants.

Use the public package export; do not copy its DTOs into a module. Local IPC accepts only the relevant `AppCommands` schema and binds the acting session in the host. Peer input uses `decodeWire`; transport framing is separate. `encodeWire` validates and returns canonical bounded UTF-8 bytes. `digestBytes` hashes exact body bytes; `projectionDigest` uses the D25 state encoding.

The accepted [D25 design](../../docs/decisions/D25-shared-space-authority.md) is the authority for `SPACE_STATE_REQUEST` and `SPACE_STATE_RESPONSE`. Their normative structural definition is [space-state-v1.schema.json](schemas/space-state-v1.schema.json), with examples and a validation command in [fixtures/contracts/v1/space-state](../../fixtures/contracts/v1/space-state/README.md). Schema acceptance alone does not authorize a peer or validate freshness.

Run from the repository root with Node 24.19.0 and pnpm 11.19.0:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test:contracts
pnpm probe:host
```

The [runtime and encoding decision](../../docs/decisions/D26-runtime-and-contract-checkpoint.md) records expiration, identity, model preparation, error semantics, tested SQLite runtime, and remaining Electron host checks. `AiPort` does not supply a QVAC implementation. Host secret/file/session interfaces are trusted injection boundaries, never renderer or peer commands.
