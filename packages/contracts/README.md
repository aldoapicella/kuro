# Shared contracts

Status: planned. Shared types, runtime validators, events, errors, and observable behavior for `AppPort`, `AiPort`, and `TransportPort`.

This package must not depend on Electron, SQLite, Pear, or QVAC. Real adapters and test doubles must satisfy the same contracts. See the [architecture](../../docs/architecture.md) for boundaries and invariants.
