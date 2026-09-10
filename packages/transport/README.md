# Peer transport

Status: implemented for Node 24 HyperDHT. `HyperDhtTransport` runs the DHT in a bounded Node worker, derives its identity from a protected 32-byte seed, admits only explicitly paired public keys, and delivers exact validated frames with `socket.remotePublicKey` as identity. The worker has no corpus, SQLite, or policy dependency.

Implements `TransportPort`. Delivers bytes and authenticated peer keys to the core and sends core-provided bytes without reconstructing evidence. It has no corpus or SQLite access.

The Node adapter waits for the SDK's encrypted-stream flush, which confirms underlying network acknowledgment. A stalled stream is closed and redialed within the bounded send attempt. This does not establish durable evidence receipt: only core validates and commits an inbox item, then sends the separate `RESPONSE_ACK`. Application framing remains the same four-byte length plus validated wire body; there is no added private probe protocol.

The host supplies an explicit `bootstrap` list and protected `secretStore`. Optional `localPort` selects the local UDP port when several nodes share a host; omission uses the library default. Defaults are 16 peer connections, 32 queued sends, a 10,000 ms deadline for an active connection/send attempt, 10,000 ms startup deadline and 5,000 ms shutdown deadline. Each send makes at most four attempts with identical bytes; its flush window is one quarter of the configured connection deadline, capped by the remaining time. HyperDHT's connection pool elects duplicate connections. Changing a paired key requires explicit host pairing; display names have no authority.

`MemoryTransport` and `MemoryNetwork` are explicit test providers. Their `flush()` operation deterministically delivers queued frames and supports configured `loss`, `duplicate`, `delay`, `reorder`, and `disconnect` faults, plus bounded pending-frame and connection limits. It is never an automatic fallback for the real adapter. `runTransportConformance` is the shared D25 ACTIVE-response suite used by both the memory tests and the two-process real-provider harness.

State synchronization is direct-authenticated and read-only: transport carries the messages and authenticated keys, while core validates snapshots, counters, leases, and local-policy intersection. See [D25](../../docs/decisions/D25-shared-space-authority.md).

Run `pnpm --filter @kuro/transport test` for framing, secret-store and memory conformance checks. Run `pnpm --filter @kuro/transport-harness smoke` for the two-process Node HyperDHT loopback check after workspace dependencies are installed.

Dependency provenance: [HyperDHT 6.34.0](https://github.com/holepunchto/hyperdht) (MIT) supplies known-key connections, authenticated streams and its connection pool. Its pinned SecretStream 6.9.1 `flush()` drains encrypted writes and delegates to [UDX 1.21.1 stream flush](https://github.com/holepunchto/udx-native#const-drained--await-streamflush), which waits for peer transport acknowledgment. No third-party implementation was copied into the worker.

The worker is a Node implementation used to demonstrate the actual HyperDHT stack. It is not yet a Bare/Pear packaged worker. The remaining runtime gate is a selected-host Bare/Pear build running the same isolated-bootstrap, persistent-router, two-peer exchange; then repeat it on the intended LAN with public Internet disconnected. A loopback pass is not a physical offline-LAN claim.
