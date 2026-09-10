# Peer transport

Status: implemented for Node 24 HyperDHT. `HyperDhtTransport` runs the DHT in a bounded Node worker, derives its identity from a protected 32-byte seed, admits only explicitly paired public keys, and delivers exact validated frames with `socket.remotePublicKey` as identity. The worker has no corpus, SQLite, or policy dependency.

Implements `TransportPort`. Delivers bytes and authenticated peer keys to the core and sends core-provided bytes without reconstructing evidence. It has no corpus or SQLite access. Provide an in-memory transport with controlled loss and repetition for testing.

`MemoryTransport` and `MemoryNetwork` are explicit test providers. Their `flush()` operation deterministically delivers queued frames and supports configured `loss`, `duplicate`, `delay`, `reorder`, and `disconnect` faults, plus bounded pending-frame and connection limits. It is never an automatic fallback for the real adapter. `runTransportConformance` is the shared D25 ACTIVE-response suite used by both the memory tests and the two-process real-provider harness.

State synchronization is direct-authenticated and read-only: transport carries the messages and authenticated keys, while core validates snapshots, counters, leases, and local-policy intersection. See [D25](../../docs/decisions/D25-shared-space-authority.md).

Run `pnpm --filter @kuro/transport test` for framing, secret-store and memory conformance checks. Run `pnpm --filter @kuro/transport-harness smoke` for the two-process Node HyperDHT loopback check after workspace dependencies are installed.

Dependency provenance: [HyperDHT 6.34.0](https://github.com/holepunchto/hyperdht) (MIT) is used through its supported `keyPair`, `createServer`, `connect`, `remotePublicKey`, `close`, and `destroy` APIs.

The worker is a Node implementation used to demonstrate the actual HyperDHT stack. It is not yet a Bare/Pear packaged worker. The remaining runtime gate is a selected-host Bare/Pear build running the same isolated-bootstrap, persistent-router, two-peer exchange; then repeat it on the intended LAN with public Internet disconnected. A loopback pass is not a physical offline-LAN claim.
