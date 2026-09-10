# Shared contracts

Status: planned. Shared types, runtime validators, events, errors, and observable behavior for `AppPort`, `AiPort`, and `TransportPort`.

This package must not depend on Electron, SQLite, Pear, or QVAC. Real adapters and test doubles must satisfy the same contracts. See the [architecture](../../docs/architecture.md) for boundaries and invariants.

Implement the shared bootstrap checkpoint from the [engineering baseline](../../docs/development/engineering-baseline.md) before building consumers. This package is the single source of truth for callable types and runtime schemas; module-private copies of public DTOs are not compatible substitutes.
