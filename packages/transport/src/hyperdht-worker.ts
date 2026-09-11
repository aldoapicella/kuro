/// <reference path="./hyperdht.d.ts" />
import HyperDHT, { type Socket } from 'hyperdht';
import { KeySchema, type TransportEvent } from '@kuro/contracts';
import { FrameDecoder, encodeFrame, validateBody } from './framing.js';
import type { FromWorker, NetworkWorkerPort, ToWorker, WorkerConfig } from './worker-protocol.js';

export function runNetworkWorker(config: WorkerConfig, port: NetworkWorkerPort): void {
  const paired = new Set(config.pairedPeers);
  const localKeyPair = HyperDHT.keyPair(config.seed);
  // HyperDHT bootstrap nodes advertise an explicit IPv4 address, never a wildcard.
  const bootstrapper = config.bootstrapPort === undefined ? undefined : HyperDHT.bootstrapper(config.bootstrapPort, config.bootstrap[0]!.host);
  const dht = new HyperDHT({ bootstrap: config.bootstrap, ...(config.port === undefined ? {} : { port: config.port }), keyPair: localKeyPair,
    ...(bootstrapper ? { ephemeral: false, firewalled: false } : {}) });
  const connectionPool = dht.pool();
  const sockets = new Map<string, Socket>();
  const attachedSockets = new Set<Socket>();
  const activatedSockets = new Set<Socket>();
  const announcedSockets = new Set<Socket>();
  const readinessTimers = new Map<Socket, NodeJS.Timeout>();
  const queue: Array<{ id: number; peerKey: string; bytes: Uint8Array }> = [];
  const MAX_SEND_ATTEMPTS = 4;
  const FLUSH_TIMEOUT_MS = Math.max(1, Math.floor(config.connectionTimeoutMs / MAX_SEND_ATTEMPTS));
  let server: Awaited<ReturnType<typeof dht.createServer>> | null = null;
  let draining = false;
  let stopping = false;
  let activeSends = 0;

  void start().catch((error: unknown) => fatal(error));
  port.onMessage((message: ToWorker) => { void receive(message).catch((error: unknown) => fatal(error)); });

  async function start(): Promise<void> {
    await bootstrapper?.fullyBootstrapped();
    if (stopping) return;
    await dht.fullyBootstrapped();
    if (stopping) return;
    connectionPool.on('connection', (socket: Socket) => attachSocket(socket));
    server = dht.createServer({ firewall: blockInbound, pool: connectionPool });
    await server.listen(localKeyPair);
    if (stopping) return;
    post({ type: 'started', publicKey: keyHex(localKeyPair.publicKey) });
  }

  function blockInbound(remotePublicKey: Uint8Array): boolean {
    let peerKey: string;
    try { peerKey = keyHex(remotePublicKey); }
    catch { return true; }
    return !paired.has(peerKey) || (!sockets.has(peerKey) && sockets.size >= config.maxConnections);
  }

  async function receive(message: ToWorker): Promise<void> {
    if (message.type === 'pair') { paired.add(message.peerKey); return; }
    if (message.type === 'remove-pair') {
      paired.delete(message.peerKey);
      destroySocket(sockets.get(message.peerKey));
      sockets.delete(message.peerKey);
      return;
    }
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
          await sendFrame(next.peerKey, encodeFrame(next.bytes));
          post({ type: 'accepted', id: next.id });
        } catch (error) {
          post({ type: 'rejected', id: next.id, code: errorCode(error) });
        } finally { activeSends--; }
      }
    } finally { draining = false; }
  }

  async function sendFrame(peerKey: string, frame: Uint8Array): Promise<void> {
    const deadline = Date.now() + config.connectionTimeoutMs;
    let lastError: unknown = new Error('Connection timed out');
    for (let attempt = 0; !stopping && attempt < MAX_SEND_ATTEMPTS && Date.now() < deadline; attempt++) {
      let socket: Socket | undefined;
      try {
        socket = await socketFor(peerKey, deadline);
        socket.write(frame);
        const flushed = await flushBefore(socket, deadline);
        if (!flushed || socket.destroyed) throw new Error('Connection closed before transport acknowledgment');
        announceConnected(peerKey, socket);
        return;
      } catch (error) {
        lastError = error;
        destroySocket(socket);
        if (attempt + 1 < MAX_SEND_ATTEMPTS && Date.now() < deadline) await retryDelay(peerKey);
      }
    }
    throw lastError;
  }

  async function socketFor(peerKey: string, deadline: number): Promise<Socket> {
    let socket = currentSocket(peerKey);
    if (socket === undefined) {
      if (!sockets.has(peerKey) && sockets.size >= config.maxConnections) throw new CapacityError();
      socket = dht.connect(Buffer.from(peerKey, 'hex'), { pool: connectionPool });
      attachSocket(socket);
    }
    return waitForOpen(socket, deadline - Date.now());
  }

  async function flushBefore(socket: Socket, deadline: number): Promise<boolean> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('Connection timed out');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        socket.flush(),
        new Promise<boolean>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Transport acknowledgment timed out')), Math.min(remainingMs, FLUSH_TIMEOUT_MS));
          timer.unref();
        }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  function attachSocket(socket: Socket): void {
    let peerKey: string;
    try { peerKey = keyHex(socket.remotePublicKey); }
    catch { socket.destroy(); return; }
    if (!paired.has(peerKey) || socket.destroyed) { socket.destroy(); return; }
    const current = sockets.get(peerKey);
    if (current === socket) return;
    if (current === undefined && sockets.size >= config.maxConnections) { socket.destroy(); return; }
    if (current !== undefined && !current.destroyed && connectionPool.get(Buffer.from(peerKey, 'hex')) !== socket) { socket.destroy(); return; }
    sockets.set(peerKey, socket);
    attachedSockets.add(socket);
    monitorSocket(peerKey, socket);
    activateSocket(peerKey, socket);
  }

  function monitorSocket(peerKey: string, socket: Socket): void {
    armReadinessTimeout(socket);
    onReady(socket, () => {
      clearReadinessTimeout(socket);
      if (!socket.isInitiator) announceConnected(peerKey, socket);
    });
    socket.once('close', () => {
      const wasAnnounced = announcedSockets.delete(socket);
      activatedSockets.delete(socket);
      attachedSockets.delete(socket);
      clearReadinessTimeout(socket);
      if (sockets.get(peerKey) !== socket) return;
      sockets.delete(peerKey);
      if (wasAnnounced) event({ type: 'disconnected', peerKey });
    });
    socket.once('error', (error: unknown) => {
      if (!stopping && errorCodeValue(error) !== 'DUPLICATE_CONNECTION' && sockets.get(peerKey) === socket) event({ type: 'error', code: 'PEER_OFFLINE' });
    });
  }

  function activateSocket(peerKey: string, socket: Socket): void {
    if (activatedSockets.has(socket)) return;
    activatedSockets.add(socket);
    const decoder = new FrameDecoder(config.maxBufferedBytes);
    socket.on('data', (chunk: Uint8Array) => {
      if (sockets.get(peerKey) !== socket) return;
      try {
        for (const body of decoder.push(chunk)) {
          validateBody(body);
          announceConnected(peerKey, socket);
          event({ type: 'message', peerKey, bytes: body });
        }
      } catch {
        event({ type: 'error', code: 'INVALID_MESSAGE' });
        socket.destroy();
      }
    });
  }

  function announceConnected(peerKey: string, socket: Socket): void {
    if (announcedSockets.has(socket) || sockets.get(peerKey) !== socket || socket.destroyed || !isReady(socket)) return;
    announcedSockets.add(socket);
    event({ type: 'connected', peerKey });
  }

  function isReady(socket: Socket): boolean { return socket.connected === true && socket.handshakeHash !== null; }
  function onReady(socket: Socket, listener: () => void): void { if (isReady(socket)) listener(); else socket.once('open', listener); }
  function currentSocket(peerKey: string): Socket | undefined {
    const socket = sockets.get(peerKey);
    return socket !== undefined && !socket.destroyed ? socket : undefined;
  }
  function armReadinessTimeout(socket: Socket): void {
    if (isReady(socket)) return;
    const timer = setTimeout(() => socket.destroy(), config.connectionTimeoutMs);
    timer.unref();
    readinessTimers.set(socket, timer);
  }
  function clearReadinessTimeout(socket: Socket): void {
    const timer = readinessTimers.get(socket);
    if (timer !== undefined) { clearTimeout(timer); readinessTimers.delete(socket); }
  }
  function destroySocket(socket: Socket | undefined): void {
    if (socket === undefined) return;
    clearReadinessTimeout(socket);
    socket.destroy();
  }

  function waitForOpen(socket: Socket, timeoutMs: number): Promise<Socket> {
    if (socket.destroyed) return Promise.reject(new Error('Socket is closed'));
    if (isReady(socket)) return Promise.resolve(socket);
    return new Promise<Socket>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); socket.destroy(); reject(new Error('Connection timed out')); }, Math.max(1, timeoutMs));
      const opened = () => { if (isReady(socket)) { cleanup(); resolve(socket); } };
      const failed = () => { cleanup(); reject(new Error('Connection failed')); };
      const cleanup = () => { clearTimeout(timeout); socket.off('open', opened); socket.off('error', failed); socket.off('close', failed); };
      socket.once('open', opened);
      socket.once('error', failed);
      socket.once('close', failed);
    });
  }

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    for (const queued of queue.splice(0)) post({ type: 'rejected', id: queued.id, code: 'PEER_OFFLINE' });
    for (const socket of attachedSockets) destroySocket(socket);
    sockets.clear();
    attachedSockets.clear();
    activatedSockets.clear();
    announcedSockets.clear();
    await server?.close();
    await dht.destroy();
    await bootstrapper?.destroy();
    post({ type: 'stopped' });
    port.close();
  }

  function keyHex(key: Uint8Array): string {
    const value = Buffer.from(key).toString('hex');
    if (!KeySchema.safeParse(value).success) throw new Error('HyperDHT supplied an invalid public key');
    return value;
  }
  function errorCodeValue(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  }
  function retryDelay(peerKey: string): Promise<void> {
    const localIsElectedInitiator = Buffer.compare(Buffer.from(localKeyPair.publicKey), Buffer.from(peerKey, 'hex')) < 0;
    const delay = localIsElectedInitiator ? 25 : Math.min(250, FLUSH_TIMEOUT_MS);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
  function event(value: TransportEvent): void { post({ type: 'event', event: value }); }
  function post(message: FromWorker): void { port.postMessage(message); }
  function fatal(error: unknown): void { if (!stopping) post({ type: 'fatal', message: error instanceof Error ? error.message : 'HyperDHT worker failed' }); }
  class CapacityError extends Error {}
  function errorCode(error: unknown): 'PEER_OFFLINE' | 'CAPACITY_EXCEEDED' { return error instanceof CapacityError ? 'CAPACITY_EXCEEDED' : 'PEER_OFFLINE'; }
}
