/// <reference path="../src/hyperdht.d.ts" />
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import HyperDHT from 'hyperdht';
import { encodeWire } from '@kuro/contracts';
import { HyperDhtTransport, InMemorySecretStore } from '../src/index.js';

test('concurrent stops serialize a same-identity restart before a new send', async () => {
  const bootstrapper = HyperDHT.bootstrapper(await reserveUdpPort(), '127.0.0.1');
  await bootstrapper.fullyBootstrapped();
  const bootstrap = [{ host: '127.0.0.1', port: bootstrapper.address().port }];
  const router = new HyperDHT({ bootstrap, port: await reserveUdpPort(), ephemeral: false, host: '127.0.0.1', firewalled: false });
  await router.fullyBootstrapped();
  const left = new HyperDhtTransport({ secretStore: seededStore(randomBytes(32)), secretName: 'seed', allowEphemeralTest: true, bootstrap, localPort: await reserveUdpPort(), connectionTimeoutMs: 500 });
  const right = new HyperDhtTransport({ secretStore: seededStore(randomBytes(32)), secretName: 'seed', allowEphemeralTest: true, bootstrap, localPort: await reserveUdpPort(), connectionTimeoutMs: 500 });
  try {
    const leftKey = (await left.start()).publicKey;
    const rightKey = (await right.start()).publicKey;
    left.pair(rightKey); right.pair(leftKey);
    const firstStop = left.stop();
    const secondStop = left.stop();
    assert.equal(secondStop, firstStop);
    const restarting = left.start();
    await firstStop;
    assert.equal((await restarting).publicKey, leftKey);
    await right.stop();
    assert.equal((await right.start()).publicKey, rightKey);
    const body = encodeWire({ v: 1, type: 'CLOSED', requestId: '1'.repeat(32), spaceAlias: '2'.repeat(32) });
    const received = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for restarted transport send')), 10_000);
      right.subscribe((event) => { if (event.type === 'message') { clearTimeout(timer); resolve(event.bytes); } });
    });
    await left.send(rightKey, body);
    assert.deepEqual(await received, body);
  } finally {
    await Promise.allSettled([left.stop(), right.stop()]);
    await router.destroy(); await bootstrapper.destroy();
  }
});

test('controlled shutdown cannot let an old worker affect a new generation', async () => {
  const workers: ControlledWorker[] = [];
  const authority = 'a'.repeat(64);
  const recipient = 'b'.repeat(64);
  const transport = new HyperDhtTransport({
    secretStore: seededStore(randomBytes(32)), secretName: 'seed', allowEphemeralTest: true,
    bootstrap: [{ host: '127.0.0.1', port: 49_737 }], pairedPeers: [recipient],
    workerFactory: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker as unknown as import('node:worker_threads').Worker;
    },
  });
  const firstStart = transport.start();
  const first = await waitForWorker(workers, 0);
  first.emit('message', { type: 'started', publicKey: authority });
  await firstStart;
  const firstStop = transport.stop();
  assert.equal(transport.stop(), firstStop, 'concurrent stops must share one shutdown');
  let restartResolved = false;
  const restarting = transport.start().then((value) => { restartResolved = true; return value; });
  await delay(20);
  assert.equal(restartResolved, false, 'start resolved before old worker shutdown');
  assert.equal(workers.length, 1, 'start created a worker before old shutdown completed');
  first.emit('message', { type: 'stopped' });
  await firstStop;
  const second = await waitForWorker(workers, 1);
  second.emit('message', { type: 'started', publicKey: authority });
  assert.equal((await restarting).publicKey, authority);
  const sent = transport.send(recipient, closedBody('6'));
  const send = second.posted.find((message): message is { type: 'send'; id: number } => isSend(message));
  assert.ok(send, 'new worker did not own the pending send');
  first.emit('message', { type: 'fatal', message: 'late old worker failure' });
  second.emit('message', { type: 'accepted', id: send.id });
  await sent;
  const stopping = transport.stop();
  second.emit('message', { type: 'stopped' });
  await stopping;
});

test('simultaneous authenticated dials retain both bounded receive paths', async () => {
  const bootstrapper = HyperDHT.bootstrapper(await reserveUdpPort(), '127.0.0.1');
  await bootstrapper.fullyBootstrapped();
  const bootstrap = [{ host: '127.0.0.1', port: bootstrapper.address().port }];
  const router = new HyperDHT({ bootstrap, port: await reserveUdpPort(), ephemeral: false, host: '127.0.0.1', firewalled: false });
  await router.fullyBootstrapped();
  const left = new HyperDhtTransport({ secretStore: seededStore(randomBytes(32)), secretName: 'seed', allowEphemeralTest: true, bootstrap, localPort: await reserveUdpPort(), connectionTimeoutMs: 1_000 });
  const right = new HyperDhtTransport({ secretStore: seededStore(randomBytes(32)), secretName: 'seed', allowEphemeralTest: true, bootstrap, localPort: await reserveUdpPort(), connectionTimeoutMs: 1_000 });
  try {
    const leftKey = (await left.start()).publicKey;
    const rightKey = (await right.start()).publicKey;
    left.pair(rightKey); right.pair(leftKey);
    const fromLeft = closedBody('7'); const fromRight = closedBody('8');
    const receivedLeft: Uint8Array[] = []; const receivedRight: Uint8Array[] = [];
    left.subscribe((event) => { if (event.type === 'message') receivedLeft.push(event.bytes); });
    right.subscribe((event) => { if (event.type === 'message') receivedRight.push(event.bytes); });
    await Promise.all([
      sendUntilBytes(left, rightKey, fromLeft, receivedRight),
      sendUntilBytes(right, leftKey, fromRight, receivedLeft),
    ]);
  } finally {
    await Promise.allSettled([left.stop(), right.stop()]);
    await router.destroy(); await bootstrapper.destroy();
  }
});

function seededStore(seed: Uint8Array): InMemorySecretStore {
  return new InMemorySecretStore('ephemeral-test', new Map([['seed', seed]]));
}
function closedBody(requestDigit: string): Uint8Array {
  return encodeWire({ v: 1, type: 'CLOSED', requestId: requestDigit.repeat(32), spaceAlias: '2'.repeat(32) });
}
class ControlledWorker extends EventEmitter {
  readonly posted: unknown[] = [];
  postMessage(message: unknown): void { this.posted.push(message); }
  terminate(): Promise<number> { return Promise.resolve(0); }
}
async function waitForWorker(workers: ControlledWorker[], index: number): Promise<ControlledWorker> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const worker = workers[index];
    if (worker !== undefined) return worker;
    await delay(5);
  }
  throw new Error('Timed out waiting for controlled worker');
}
function isSend(message: unknown): message is { type: 'send'; id: number } {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'send' && typeof (message as { id?: unknown }).id === 'number';
}
async function sendUntilBytes(sender: HyperDhtTransport, peerKey: string, bytes: Uint8Array, received: Uint8Array[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sender.send(peerKey, bytes);
    const observationDeadline = Math.min(deadline, Date.now() + 100);
    while (Date.now() < observationDeadline) {
      if (received.some((candidate) => Buffer.from(candidate).equals(Buffer.from(bytes)))) return;
      await delay(10);
    }
  }
  throw new Error('Timed out waiting for simultaneous dial bytes');
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function reserveUdpPort(): Promise<number> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', () => resolve()); });
  const address = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  if (typeof address === 'string' || address.port === 0) throw new Error('Could not reserve a UDP port');
  return address.port;
}
