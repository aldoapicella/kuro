# Peer transport

Status: planned. Pear/HyperDHT adapter, network worker, bounded framing, authenticated identity, lifecycle management, and the `SPACE_STATE_REQUEST`/`SPACE_STATE_RESPONSE` exchange with the pinned authority.

Implements `TransportPort`. Delivers bytes and authenticated peer keys to the core and sends core-provided bytes without reconstructing evidence. It has no corpus or SQLite access. Provide an in-memory transport with controlled loss and repetition for testing.

State synchronization is direct-authenticated and read-only: transport carries the messages and authenticated keys, while core validates snapshots, counters, leases, and local-policy intersection. See [D25](../../docs/decisions/D25-shared-space-authority.md).
