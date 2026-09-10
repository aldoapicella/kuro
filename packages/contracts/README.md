# Shared contracts

Status: D25 shared-state JSON Schema and synthetic fixtures are defined. Callable TypeScript interfaces, runtime adapters, and stateful conformance remain planned, including `AppPort`, `AiPort`, `TransportPort`, and the five evidence-protocol schemas.

This package must not depend on Electron, SQLite, Pear, or QVAC. Real adapters and test doubles must satisfy the same contracts. See the [architecture](../../docs/architecture.md) for boundaries and invariants.

Implement the shared bootstrap checkpoint from the [engineering baseline](../../docs/development/engineering-baseline.md) before building consumers. This package is the single source of truth for callable types and runtime schemas; module-private copies of public DTOs are not compatible substitutes.

The accepted [D25 design](../../docs/decisions/D25-shared-space-authority.md) is the authority for `SPACE_STATE_REQUEST` and `SPACE_STATE_RESPONSE`. Their normative structural definition is [space-state-v1.schema.json](schemas/space-state-v1.schema.json), with examples and a validation command in [fixtures/contracts/v1/space-state](../../fixtures/contracts/v1/space-state/README.md). Schema acceptance alone does not authorize a peer or validate freshness.
