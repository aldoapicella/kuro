# Custody core

Status: planned. Domain rules, use cases, authorization, versioned documents, SQLite, scheduling, approval, outbox, and inbox.

Exposes `AppPort` and consumes `AiPort` and `TransportPort`. Owns the single logical writer and the transaction that revalidates permissions and persists approval with exact outgoing bytes. See the [architecture](../../docs/architecture.md).
