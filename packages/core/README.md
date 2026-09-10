# Custody core

Status: planned. Domain rules, shared-space authority commands/publications, recipient cache installation, local document policy, versioned documents, SQLite, scheduling, approval, outbox, and inbox.

Exposes `AppPort` and consumes `AiPort` and `TransportPort`. Owns the single logical writer and the transaction that revalidates permissions and persists approval with exact outgoing bytes. See the [architecture](../../docs/architecture.md).

The pinned shared owner controls membership, device bindings, coarse capabilities, and recipient neighborhoods. Each custodian intersects that snapshot with its local grants and restrictions; cached shared state never grants document access by itself. See the accepted [D25 design](../../docs/decisions/D25-shared-space-authority.md).
