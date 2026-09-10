import { KeySchema, type TransportEvent, type TransportPort } from '@kuro/contracts';
import { validateBody } from './framing.js';

export interface MemoryFaults {
  /** Drop each accepted frame until changed. */
  loss?: boolean;
  /** Deliver each accepted frame twice until changed. */
  duplicate?: boolean;
  /** Number of explicit flush calls to defer delivery. */
  delay?: number;
  /** Deliver due frames in reverse insertion order. */
  reorder?: boolean;
  /** Reject sends and suppress deliveries until changed. */
  disconnect?: boolean;
  /** Maximum queued frames; a configured duplicate consumes one additional slot. */
  maxPendingFrames?: number;
}

export interface MemoryTransportOptions {
  network: MemoryNetwork;
  publicKey: string;
  pairedPeers?: Iterable<string>;
  maxConnections?: number;
}

interface PendingFrame { from: string; to: string; bytes: Uint8Array; dueFlush: number; ordinal: number }

/** Deterministic explicit-flush test network. It is never selected by a production adapter. */
export class MemoryNetwork {
  #nodes = new Map<string, MemoryTransport>();
  #queue: PendingFrame[] = [];
  #flushes = 0;
  #ordinal = 0;
  #faults: MemoryFaults;
  readonly #maxPendingFrames: number;

  constructor(faults: MemoryFaults = {}) { this.#faults = checkedFaults(faults); this.#maxPendingFrames = faults.maxPendingFrames ?? 32; }
  setFaults(faults: MemoryFaults): void { this.#faults = checkedFaults(faults); }
  get pendingFrames(): number { return this.#queue.length; }

  register(node: MemoryTransport): void {
    if (this.#nodes.has(node.publicKey)) throw new Error('Memory transport key is already running');
    this.#nodes.set(node.publicKey, node);
  }
  unregister(node: MemoryTransport): void {
    if (this.#nodes.get(node.publicKey) === node) this.#nodes.delete(node.publicKey);
    this.#queue = this.#queue.filter((frame) => frame.from !== node.publicKey && frame.to !== node.publicKey);
  }
  enqueue(from: MemoryTransport, peerKey: string, bytes: Uint8Array): void {
    const target = this.#nodes.get(peerKey);
    if (this.#faults.disconnect || target === undefined || !from.isPaired(peerKey) || !target.isPaired(from.publicKey)) {
      throw new MemoryTransportError('PEER_OFFLINE', 'Paired peer is unavailable');
    }
    if (!from.canConnect(peerKey) || !target.canConnect(from.publicKey)) throw new MemoryTransportError('CAPACITY_EXCEEDED', 'Connection capacity exceeded');
    from.connected(peerKey);
    target.connected(from.publicKey);
    if (this.#faults.loss) return;
    const copies = this.#faults.duplicate ? 2 : 1;
    if (this.#queue.length + copies > this.#maxPendingFrames) throw new MemoryTransportError('CAPACITY_EXCEEDED', 'Memory queue capacity exceeded');
    const dueFlush = this.#flushes + (this.#faults.delay ?? 0) + 1;
    this.#queue.push({ from: from.publicKey, to: peerKey, bytes: new Uint8Array(bytes), dueFlush, ordinal: this.#ordinal++ });
    if (this.#faults.duplicate) this.#queue.push({ from: from.publicKey, to: peerKey, bytes: new Uint8Array(bytes), dueFlush, ordinal: this.#ordinal++ });
  }
  /** Advances one deterministic network turn; no timer is used by this provider. */
  flush(): void {
    this.#flushes++;
    if (this.#faults.disconnect) return;
    const due = this.#queue.filter((frame) => frame.dueFlush <= this.#flushes);
    this.#queue = this.#queue.filter((frame) => frame.dueFlush > this.#flushes);
    due.sort((left, right) => this.#faults.reorder ? right.ordinal - left.ordinal : left.ordinal - right.ordinal);
    for (const frame of due) {
      const target = this.#nodes.get(frame.to);
      const source = this.#nodes.get(frame.from);
      if (target === undefined || source === undefined || !source.isPaired(frame.to) || !target.isPaired(frame.from)) continue;
      target.receive(frame.from, frame.bytes);
    }
  }
}

export class MemoryTransport implements TransportPort {
  readonly #listeners = new Set<(event: TransportEvent) => void>();
  readonly #paired = new Set<string>();
  #running = false;
  #connected = new Set<string>();
  readonly #maxConnections: number;

  constructor(readonly options: MemoryTransportOptions) {
    assertKey(options.publicKey);
    if (!Number.isSafeInteger(options.maxConnections ?? 16) || (options.maxConnections ?? 16) < 1) throw new Error('Invalid memory connection limit');
    this.#maxConnections = options.maxConnections ?? 16;
    for (const peerKey of options.pairedPeers ?? []) this.pair(peerKey);
  }
  get publicKey(): string { return this.options.publicKey; }
  async start(): Promise<{ publicKey: string }> {
    if (!this.#running) { this.options.network.register(this); this.#running = true; }
    return { publicKey: this.publicKey };
  }
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.options.network.unregister(this);
    for (const peerKey of this.#connected) this.emit({ type: 'disconnected', peerKey });
    this.#connected.clear();
    this.#running = false;
  }
  async send(peerKey: string, bytes: Uint8Array): Promise<void> {
    if (!this.#running) throw new MemoryTransportError('PEER_OFFLINE', 'Transport is stopped');
    assertKey(peerKey);
    validateBody(bytes);
    this.options.network.enqueue(this, peerKey, bytes);
  }
  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  pair(peerKey: string): void { assertKey(peerKey); if (peerKey !== this.publicKey) this.#paired.add(peerKey); }
  removePair(peerKey: string): void {
    this.#paired.delete(peerKey);
    if (this.#connected.delete(peerKey)) this.emit({ type: 'disconnected', peerKey });
  }
  isPaired(peerKey: string): boolean { return this.#paired.has(peerKey); }
  canConnect(peerKey: string): boolean { return this.#connected.has(peerKey) || this.#connected.size < this.#maxConnections; }
  connected(peerKey: string): void {
    if (!this.#connected.has(peerKey)) { this.#connected.add(peerKey); this.emit({ type: 'connected', peerKey }); }
  }
  receive(peerKey: string, bytes: Uint8Array): void {
    if (!this.#running || !this.isPaired(peerKey)) return;
    try { validateBody(bytes); this.emit({ type: 'message', peerKey, bytes: new Uint8Array(bytes) }); }
    catch { this.emit({ type: 'error', code: 'INVALID_MESSAGE' }); }
  }
  private emit(event: TransportEvent): void { for (const listener of this.#listeners) { try { listener(event); } catch { /* A subscriber cannot take down transport. */ } } }
}

export class MemoryTransportError extends Error {
  constructor(readonly code: 'PEER_OFFLINE' | 'INVALID_MESSAGE' | 'CAPACITY_EXCEEDED', message: string) { super(message); }
}

function assertKey(value: string): void { if (!KeySchema.safeParse(value).success) throw new Error('Invalid paired peer key'); }
function checkedFaults(faults: MemoryFaults): MemoryFaults {
  if (faults.delay !== undefined && (!Number.isSafeInteger(faults.delay) || faults.delay < 0)) throw new Error('Memory delay must be a nonnegative integer');
  if (faults.maxPendingFrames !== undefined && (!Number.isSafeInteger(faults.maxPendingFrames) || faults.maxPendingFrames < 1)) throw new Error('Memory queue limit must be a positive integer');
  return { ...faults };
}
