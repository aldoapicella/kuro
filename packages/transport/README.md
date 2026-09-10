# Peer transport

Status: planned. Pear/HyperDHT adapter, network worker, bounded framing, authenticated identity, and lifecycle management.

Implements `TransportPort`. Delivers bytes and authenticated peer keys to the core and sends core-provided bytes without reconstructing evidence. It has no corpus or SQLite access. Provide an in-memory transport with controlled loss and repetition for testing.
