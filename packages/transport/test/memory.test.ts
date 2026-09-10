import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeWire, type SecretStore, type TransportPort } from '@kuro/contracts';
import { FrameDecoder, HyperDhtTransport, InMemorySecretStore, MemoryNetwork, MemoryTransport, encodeFrame, loadOrCreateSeed, runTransportConformance, spaceStateRequestBytes, validateBody } from '../src/index.js';

const authority = 'a'.repeat(64);
const recipient = 'b'.repeat(64);
const closed = encodeWire({ v: 1, type: 'CLOSED', requestId: '1'.repeat(32), spaceAlias: '2'.repeat(32) });

test('memory provider runs the shared D25 ACTIVE response conformance suite', async () => {
  const network = new MemoryNetwork();
  const left = new MemoryTransport({ network, publicKey: authority, pairedPeers: [recipient] });
  const right = new MemoryTransport({ network, publicKey: recipient, pairedPeers: [authority] });
  await left.start(); await right.start();
  const result = await runTransportConformance({ sender: left, recipient: right, senderKey: authority, recipientKey: recipient, releaseAuthorityObservation: () => network.flush(), releaseRecipientObservation: () => network.flush(), reconnectRecipient: async () => { await right.stop(); await right.start(); } });
  assert.equal(result.deliveries, 5);
  await left.stop(); await right.stop();
});

test('conformance retries a lost request and ignores a delayed old request after reconnect', async () => {
  const network = new MemoryNetwork({ loss: true });
  const left = new MemoryTransport({ network, publicKey: authority, pairedPeers: [recipient] });
  const right = new MemoryTransport({ network, publicKey: recipient, pairedPeers: [authority] });
  const authorityMessages: Uint8Array[] = [];
  left.subscribe((event) => { if (event.type === 'message') authorityMessages.push(event.bytes); });
  await left.start(); await right.start();
  let authorityReleases = 0;
  const result = await runTransportConformance({
    sender: left, recipient: right, senderKey: authority, recipientKey: recipient, timeoutMs: 1_000,
    releaseAuthorityObservation: () => {
      network.flush();
      if (++authorityReleases === 1) network.setFaults({});
    },
    releaseRecipientObservation: () => network.flush(),
    reconnectRecipient: async () => { await right.stop(); await right.start(); },
    afterReconnect: async () => {
      // This is a late copy of the first correlated request. It must not satisfy requestId 6.
      await right.send(authority, spaceStateRequestBytes('1'.repeat(32)));
      network.flush();
    },
  });
  assert.equal(result.deliveries, 5);
  const oldRequest = spaceStateRequestBytes('1'.repeat(32));
  const freshRequest = spaceStateRequestBytes('6'.repeat(32));
  assert.ok(authorityMessages.filter((bytes) => Buffer.from(bytes).equals(Buffer.from(oldRequest))).length >= 2, 'lost request was not retried with identical bytes');
  assert.equal(authorityMessages.filter((bytes) => Buffer.from(bytes).equals(Buffer.from(freshRequest))).length, 1);
  await left.stop(); await right.stop();
});

test('conformance permits delivery before send resolves when observation is not explicitly held', async () => {
  const network = new MemoryNetwork();
  const left = new MemoryTransport({ network, publicKey: authority, pairedPeers: [recipient] });
  const right = new MemoryTransport({ network, publicKey: recipient, pairedPeers: [authority] });
  const immediate = (peer: MemoryTransport): TransportPort => ({
    start: () => peer.start(), stop: () => peer.stop(), subscribe: listener => peer.subscribe(listener),
    async send(key, bytes) { await peer.send(key, bytes); network.flush(); },
  });
  await left.start(); await right.start();
  try {
    const result = await runTransportConformance({ sender: immediate(left), recipient: immediate(right), senderKey: authority, recipientKey: recipient, reconnectRecipient: async () => { await right.stop(); await right.start(); } });
    assert.equal(result.deliveries, 5);
  } finally { await left.stop(); await right.stop(); }
});

test('memory network explicitly injects delay, duplication, reordering, loss and disconnection', async () => {
  const network = new MemoryNetwork({ delay: 1, duplicate: true, reorder: true });
  const left = new MemoryTransport({ network, publicKey: authority, pairedPeers: [recipient] });
  const right = new MemoryTransport({ network, publicKey: recipient, pairedPeers: [authority] });
  const received: Uint8Array[] = [];
  right.subscribe((event) => { if (event.type === 'message') received.push(event.bytes); });
  await left.start(); await right.start();
  await left.send(recipient, closed);
  network.flush(); assert.equal(received.length, 0);
  network.flush(); assert.deepEqual(received, [closed, closed]);
  network.setFaults({ loss: true });
  await left.send(recipient, closed); network.flush(); assert.equal(received.length, 2);
  network.setFaults({ disconnect: true });
  await assert.rejects(left.send(recipient, closed));
  await left.stop(); await right.stop();
});

test('framing handles split and combined frames while rejecting invalid declared sizes', () => {
  const frame = encodeFrame(closed);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(frame.slice(0, 2)), []);
  assert.deepEqual(decoder.push(frame.slice(2)), [closed]);
  const combined = new Uint8Array(frame.byteLength * 2); combined.set(frame); combined.set(frame, frame.byteLength);
  assert.deepEqual(decoder.push(combined), [closed, closed]);
  for (const body of decoder.push(new Uint8Array(0))) validateBody(body);
  const oversized = Uint8Array.of(0, 0, 128, 1);
  assert.throws(() => new FrameDecoder().push(oversized));
  assert.throws(() => validateBody(Uint8Array.of(0xc3, 0x28)));
  assert.throws(() => validateBody(new TextEncoder().encode('{"v":1,"type":"CLOSED"')));
});

test('memory queue and connection limits fail closed, and a failing listener is contained', async () => {
  const network = new MemoryNetwork({ delay: 2, maxPendingFrames: 1 });
  const left = new MemoryTransport({ network, publicKey: authority, pairedPeers: [recipient], maxConnections: 1 });
  const right = new MemoryTransport({ network, publicKey: recipient, pairedPeers: [authority] });
  await left.start(); await right.start();
  await left.send(recipient, closed);
  await assert.rejects(left.send(recipient, closed), /capacity/i);
  let delivered = 0;
  right.subscribe(() => { throw new Error('subscriber failure'); });
  right.subscribe((event) => { if (event.type === 'message') delivered++; });
  network.flush(); network.flush(); network.flush();
  assert.equal(delivered, 1);
  await left.stop(); await right.stop();

  const third = 'c'.repeat(64);
  const constrained = new MemoryNetwork();
  const source = new MemoryTransport({ network: constrained, publicKey: authority, pairedPeers: [recipient, third], maxConnections: 1 });
  const firstPeer = new MemoryTransport({ network: constrained, publicKey: recipient, pairedPeers: [authority] });
  const secondPeer = new MemoryTransport({ network: constrained, publicKey: third, pairedPeers: [authority] });
  await source.start(); await firstPeer.start(); await secondPeer.start();
  await source.send(recipient, closed);
  await assert.rejects(source.send(third, closed), /capacity/i);
  await source.stop(); await firstPeer.stop(); await secondPeer.stop();
});

test('ephemeral storage is explicit and unavailable or basic-text stores are rejected', async () => {
  const ephemeral = new InMemorySecretStore();
  await assert.rejects(loadOrCreateSeed(ephemeral, 'seed'));
  const seed = await loadOrCreateSeed(ephemeral, 'seed', true);
  assert.equal(seed.byteLength, 32);
  assert.deepEqual(await loadOrCreateSeed(ephemeral, 'seed', true), seed);
  await assert.rejects(loadOrCreateSeed(new InMemorySecretStore('unavailable'), 'seed', true));
  await assert.rejects(loadOrCreateSeed(new InMemorySecretStore('basic_text'), 'seed', true));
});

test('concurrent identity creation uses the durable atomic winner and never an overwritten seed', async () => {
  let reads = 0;
  let releaseReads!: () => void;
  const bothRead = new Promise<void>(resolve => { releaseReads = resolve; });
  let stored: Uint8Array | null = null;
  const atomicStore: SecretStore = {
    async protection() { return 'os-protected'; },
    async read() { if (++reads === 2) releaseReads(); await bothRead; return null; },
    async createIfAbsent(_name, candidate) {
      // Represents the host's atomic durable create-if-absent operation.
      stored ??= new Uint8Array(candidate);
      return new Uint8Array(stored);
    },
  };
  const [first, second] = await Promise.all([loadOrCreateSeed(atomicStore, 'seed'), loadOrCreateSeed(atomicStore, 'seed')]);
  assert.deepEqual(first, second); assert.deepEqual(first, stored);
  const memory = new InMemorySecretStore();
  const [winner, repeated] = await Promise.all([memory.createIfAbsent('seed', first), memory.createIfAbsent('seed', new Uint8Array(32).fill(7))]);
  assert.deepEqual(winner, first); assert.deepEqual(repeated, first); assert.deepEqual(await memory.read('seed'), first);
  const invalidStore: SecretStore = { ...atomicStore, async read() { return null; }, async createIfAbsent() { return new Uint8Array(31); } };
  await assert.rejects(loadOrCreateSeed(invalidStore, 'seed'), /invalid length/);
});

test('real adapter stop cancels a pending protected-seed startup before it can create a worker', async () => {
  let releaseRead: (value: Uint8Array | null) => void = () => { throw new Error('read resolver not initialized'); };
  const pendingRead = new Promise<Uint8Array | null>((resolve) => { releaseRead = resolve; });
  const delayedStore: SecretStore = {
    async protection() { return 'os-protected'; },
    read() { return pendingRead; },
    async createIfAbsent(_name, candidate) { return candidate; },
  };
  const transport = new HyperDhtTransport({ secretStore: delayedStore, bootstrap: [{ host: '127.0.0.1', port: 49_737 }], startupTimeoutMs: 100 });
  const starting = transport.start();
  await Promise.resolve();
  await transport.stop();
  releaseRead(null);
  await assert.rejects(starting, /stopped during start/);
});

test('real adapter startup deadline includes a SecretStore that never returns and ignores its late result', async () => {
  let releaseRead: (value: Uint8Array | null) => void = () => { throw new Error('read resolver not initialized'); };
  const pendingRead = new Promise<Uint8Array | null>((resolve) => { releaseRead = resolve; });
  const neverStore: SecretStore = {
    async protection() { return 'os-protected'; },
    read() { return pendingRead; },
    async createIfAbsent(_name, candidate) { return candidate; },
  };
  const transport = new HyperDhtTransport({ secretStore: neverStore, bootstrap: [{ host: '127.0.0.1', port: 49_737 }], startupTimeoutMs: 20 });
  await assert.rejects(transport.start(), /startup timed out/);
  releaseRead(null);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  await assert.rejects(transport.send(recipient, closed), /not started/);
  await transport.stop();
});
