/// <reference path="./hyperdht.d.ts" />
import { parentPort, workerData } from 'node:worker_threads';
import HyperDHT, { type Socket } from 'hyperdht';
import { KeySchema, type TransportEvent } from '@kuro/contracts';
import { FrameDecoder, encodeFrame, validateBody } from './framing.js';
import type { FromWorker, ToWorker, WorkerConfig } from './worker-protocol.js';

if (parentPort === null) throw new Error('HyperDHT worker requires a parent port');
const port = parentPort;
const config = workerData as WorkerConfig;
const paired = new Set(config.pairedPeers);
const dht = new HyperDHT({ bootstrap: config.bootstrap, keyPair: HyperDHT.keyPair(config.seed) });
const sockets = new Map<string, Socket>();
const openedSockets = new Set<Socket>();
const queue: Array<{ id: number; peerKey: string; bytes: Uint8Array }> = [];
let server: Awaited<ReturnType<typeof dht.createServer>> | null = null;
let draining = false;
let stopping = false;
let activeSends = 0;

void start().catch((error: unknown) => fatal(error));
port.on('message', (message: ToWorker) => { void receive(message); });

async function start(): Promise<void> {
  await dht.fullyBootstrapped();
  server = dht.createServer({ firewall: (remotePublicKey) => !paired.has(keyHex(remotePublicKey)) }, (socket) => attachSocket(socket));
  await server.listen(HyperDHT.keyPair(config.seed));
  post({ type: 'started', publicKey: keyHex(HyperDHT.keyPair(config.seed).publicKey) });
}

async function receive(message: ToWorker): Promise<void> {
  if (message.type === 'pair') { paired.add(message.peerKey); return; }
  if (message.type === 'remove-pair') { paired.delete(message.peerKey); sockets.get(message.peerKey)?.destroy(); sockets.delete(message.peerKey); return; }
  if (message.type === 'stop') { await shutdown(); return; }
  if (message.type !== 'send') return;
  if (stopping) { post({ type: 'rejected', id: message.id, code: 'PEER_OFFLINE' }); return; }
  if (!paired.has(message.peerKey)) { post({ type: 'rejected', id: message.id, code: 'PEER_OFFLINE' }); return; }
  try { validateBody(message.bytes); }
  catch { post({ type: 'rejected', id: message.id, code: 'INVALID_MESSAGE' }); return; }
  if (queue.length + activeSends >= config.maxQueuedSends) { post({ type: 'rejected', id: message.id, code: 'CAPACITY_EXCEEDED' }); return; }
  queue.push({ id: message.id, peerKey: message.peerKey, bytes: new Uint8Array(message.bytes) });
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0 && !stopping) {
      const next = queue.shift();
      if (next === undefined) continue;
      activeSends++;
      try {
        const socket = await socketFor(next.peerKey);
        socket.write(encodeFrame(next.bytes));
        post({ type: 'accepted', id: next.id });
      } catch (error) {
        post({ type: 'rejected', id: next.id, code: errorCode(error) });
      } finally { activeSends--; }
    }
  } finally { draining = false; }
}

async function socketFor(peerKey: string): Promise<Socket> {
  const existing = sockets.get(peerKey);
  if (existing !== undefined && !existing.destroyed) return waitForOpen(existing);
  if (sockets.size >= config.maxConnections) throw new CapacityError();
  const socket = dht.connect(Buffer.from(peerKey, 'hex'));
  attachSocket(socket);
  return waitForOpen(socket);
}

function attachSocket(socket: Socket): void {
  let peerKey: string;
  try { peerKey = keyHex(socket.remotePublicKey); }
  catch { socket.destroy(); return; }
  if (!paired.has(peerKey) || (sockets.has(peerKey) && sockets.get(peerKey) !== socket) || sockets.size >= config.maxConnections) { socket.destroy(); return; }
  sockets.set(peerKey, socket);
  const decoder = new FrameDecoder(config.maxBufferedBytes);
  let announced = false;
  const connected = () => {
    if (!announced && !socket.destroyed) { announced = true; openedSockets.add(socket); event({ type: 'connected', peerKey }); }
  };
  socket.once('open', connected);
  socket.on('data', (chunk: Uint8Array) => {
    try {
      for (const body of decoder.push(chunk)) { validateBody(body); event({ type: 'message', peerKey, bytes: body }); }
    } catch {
      event({ type: 'error', code: 'INVALID_MESSAGE' });
      socket.destroy();
    }
  });
  socket.once('close', () => {
    openedSockets.delete(socket);
    if (sockets.get(peerKey) === socket) { sockets.delete(peerKey); if (announced) event({ type: 'disconnected', peerKey }); }
  });
  socket.once('error', () => { if (!stopping) event({ type: 'error', code: 'PEER_OFFLINE' }); });
}

function waitForOpen(socket: Socket): Promise<Socket> {
  if (socket.destroyed) return Promise.reject(new Error('Socket is closed'));
  if (openedSockets.has(socket)) return Promise.resolve(socket);
  return new Promise<Socket>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); socket.destroy(); reject(new Error('Connection timed out')); }, config.connectionTimeoutMs);
    const opened = () => { cleanup(); resolve(socket); };
    const failed = () => { cleanup(); reject(new Error('Connection failed')); };
    const cleanup = () => { clearTimeout(timeout); socket.off('open', opened); socket.off('error', failed); socket.off('close', failed); };
    socket.once('open', opened); socket.once('error', failed); socket.once('close', failed);
  });
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const queued of queue.splice(0)) post({ type: 'rejected', id: queued.id, code: 'PEER_OFFLINE' });
  for (const socket of sockets.values()) socket.destroy();
  sockets.clear();
  await server?.close();
  await dht.destroy();
  post({ type: 'stopped' });
  port.close();
}

function keyHex(key: Uint8Array): string {
  const value = Buffer.from(key).toString('hex');
  if (!KeySchema.safeParse(value).success) throw new Error('HyperDHT supplied an invalid public key');
  return value;
}
function event(value: TransportEvent): void { post({ type: 'event', event: value }); }
function post(message: FromWorker): void { port.postMessage(message); }
function fatal(error: unknown): void { post({ type: 'fatal', message: error instanceof Error ? error.message : 'HyperDHT worker failed' }); }
class CapacityError extends Error {}
function errorCode(error: unknown): 'PEER_OFFLINE' | 'CAPACITY_EXCEEDED' { return error instanceof CapacityError ? 'CAPACITY_EXCEEDED' : 'PEER_OFFLINE'; }
