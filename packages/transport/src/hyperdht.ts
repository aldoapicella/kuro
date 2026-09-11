import type { Worker, WorkerOptions } from 'node:worker_threads';
import { BareTransportWorker, type TransportWorker } from './bare-worker.js';
import { KeySchema, type SecretStore, type TransportEvent, type TransportPort } from '@kuro/contracts';
import { MAX_FRAME_BYTES, validateBody } from './framing.js';
import { loadOrCreateSeed } from './secrets.js';
import type { FromWorker, ToWorker, WorkerBootstrap, WorkerConfig } from './worker-protocol.js';

export interface HyperDhtTransportOptions {
  secretStore: SecretStore;
  /** The protected-store record. The seed is expanded with HyperDHT.keyPair(seed) in the worker. */
  secretName?: string;
  bootstrap: readonly WorkerBootstrap[];
  /** Optional local UDP port for a host running multiple DHT peers. */
  localPort?: number;
  pairedPeers?: Iterable<string>;
  maxConnections?: number;
  maxBufferedBytes?: number;
  maxQueuedSends?: number;
  connectionTimeoutMs?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** Trusted host override for the built Bare worker asset when packaging the application. */
  workerUrl?: URL;
  /** Test-only escape hatch for InMemorySecretStore; production must omit it. */
  allowEphemeralTest?: boolean;
  /** Test-only worker seam for bounded lifecycle tests. Production must omit it. */
  workerFactory?: (url: URL, options: WorkerOptions) => Worker;
}
interface ResolvedOptions {
  secretStore: SecretStore;
  allowEphemeralTest: boolean;
  secretName: string;
  bootstrap: readonly WorkerBootstrap[];
  localPort: number | undefined;
  maxConnections: number;
  maxBufferedBytes: number;
  maxQueuedSends: number;
  connectionTimeoutMs: number;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  workerUrl: URL;
  workerFactory: ((url: URL, options: WorkerOptions) => Worker) | undefined;
}

export class HyperDhtTransport implements TransportPort {
  readonly #listeners = new Set<(event: TransportEvent) => void>();
  readonly #pairs = new Set<string>();
  readonly #options: ResolvedOptions;
  #worker: TransportWorker | null = null;
  #publicKey: string | null = null;
  #nextId = 1;
  #pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  #start: { resolve(value: { publicKey: string }): void; reject(error: Error): void } | null = null;
  #startPromise: Promise<{ publicKey: string }> | null = null;
  #startTimeout: NodeJS.Timeout | null = null;
  #generation = 0;
  #stopPromise: Promise<void> | null = null;

  constructor(options: HyperDhtTransportOptions) {
    for (const peerKey of options.pairedPeers ?? []) this.assertKey(peerKey), this.#pairs.add(peerKey);
    this.#options = {
      secretStore: options.secretStore,
      allowEphemeralTest: options.allowEphemeralTest === true,
      secretName: options.secretName ?? 'kuro.transport.hyperdht.seed.v1',
      bootstrap: options.bootstrap.map((node) => ({ ...node })),
      localPort: options.localPort,
      maxConnections: options.maxConnections ?? 16,
      maxBufferedBytes: options.maxBufferedBytes ?? MAX_FRAME_BYTES * 4,
      maxQueuedSends: options.maxQueuedSends ?? 32,
      connectionTimeoutMs: options.connectionTimeoutMs ?? 10_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
      workerUrl: options.workerUrl ?? new URL('../dist/bare-worker.mjs', import.meta.url),
      workerFactory: options.workerFactory,
    };
    this.validateOptions();
  }

  async start(): Promise<{ publicKey: string }> {
    const stopping = this.#stopPromise;
    if (stopping !== null) await stopping;
    if (this.#publicKey !== null) return { publicKey: this.#publicKey };
    if (this.#startPromise !== null) return this.#startPromise;
    const generation = ++this.#generation;
    const promise = new Promise<{ publicKey: string }>((resolve, reject) => {
      this.#start = { resolve, reject };
      this.#startTimeout = setTimeout(() => {
        if (this.#generation === generation) this.fail(new Error('HyperDHT worker startup timed out'));
      }, this.#options.startupTimeoutMs);
      void this.startWorker(generation);
    });
    this.#startPromise = promise;
    try { return await promise; } finally { if (this.#startPromise === promise) this.#startPromise = null; }
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    const stopping = this.stopWorker();
    this.#stopPromise = stopping;
    void stopping.then(
      () => { if (this.#stopPromise === stopping) this.#stopPromise = null; },
      () => { if (this.#stopPromise === stopping) this.#stopPromise = null; },
    );
    return stopping;
  }

  private async stopWorker(): Promise<void> {
    ++this.#generation;
    const worker = this.#worker;
    this.#worker = null;
    this.#publicKey = null;
    this.rejectStart(new Error('Transport stopped during start'));
    for (const pending of this.#pending.values()) pending.reject(new Error('Transport stopped'));
    this.#pending.clear();
    if (worker === null) return;
    const stopped = new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); worker.off('message', onMessage); worker.off('exit', onExit); worker.off('error', onError); };
      const timeout = setTimeout(() => { cleanup(); void worker.terminate().then(() => reject(new Error('HyperDHT worker shutdown timed out')), reject); }, this.#options.shutdownTimeoutMs);
      const onMessage = (message: FromWorker) => { if (message.type === 'stopped') { cleanup(); resolve(); } };
      const onExit = () => { cleanup(); reject(new Error('HyperDHT worker exited before clean shutdown')); };
      const onError = (error: Error) => { cleanup(); void worker.terminate(); reject(error); };
      worker.on('message', onMessage);
      worker.once('exit', onExit);
      worker.once('error', onError);
    });
    worker.postMessage({ type: 'stop' } satisfies ToWorker);
    await stopped;
  }

  async send(peerKey: string, bytes: Uint8Array): Promise<void> {
    this.assertKey(peerKey);
    validateBody(bytes);
    const worker = this.#worker;
    if (worker === null || this.#publicKey === null) throw new HyperDhtTransportError('PEER_OFFLINE', 'Transport is not started');
    if (!this.#pairs.has(peerKey)) throw new HyperDhtTransportError('PEER_OFFLINE', 'Peer is not paired');
    if (this.#pending.size >= this.#options.maxQueuedSends) throw new HyperDhtTransportError('CAPACITY_EXCEEDED', 'Transport send capacity exceeded');
    const id = this.#nextId++;
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'send', id, peerKey, bytes: new Uint8Array(bytes) } satisfies ToWorker);
    });
  }

  subscribe(listener: (event: TransportEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  pair(peerKey: string): void { this.assertKey(peerKey); this.#pairs.add(peerKey); this.#worker?.postMessage({ type: 'pair', peerKey } satisfies ToWorker); }
  removePair(peerKey: string): void { this.#pairs.delete(peerKey); this.#worker?.postMessage({ type: 'remove-pair', peerKey } satisfies ToWorker); }

  private workerConfig(seed: Uint8Array): WorkerConfig {
    return { seed, bootstrap: this.#options.bootstrap, port: this.#options.localPort, pairedPeers: [...this.#pairs], maxConnections: this.#options.maxConnections, maxBufferedBytes: this.#options.maxBufferedBytes, maxQueuedSends: this.#options.maxQueuedSends, connectionTimeoutMs: this.#options.connectionTimeoutMs };
  }
  private async startWorker(generation: number): Promise<void> {
    try {
      const seed = await loadOrCreateSeed(this.#options.secretStore, this.#options.secretName, this.#options.allowEphemeralTest);
      if (!this.isStarting(generation)) return;
      const workerUrl = this.#options.workerUrl;
      const worker = this.#options.workerFactory?.(workerUrl, { workerData: this.workerConfig(seed) }) ?? new BareTransportWorker(workerUrl, this.workerConfig(seed));
      if (!this.isStarting(generation)) { void worker.terminate(); return; }
      this.#worker = worker;
      worker.on('message', (message: FromWorker) => { if (this.#worker === worker) this.onWorkerMessage(worker, message); });
      worker.once('error', (error) => { if (this.#worker === worker) this.fail(error); });
      worker.once('exit', (code) => { if (this.#worker === worker) this.fail(new Error(`HyperDHT worker exited unexpectedly with code ${code}`), false); });
    } catch (error) {
      if (this.isStarting(generation)) this.fail(error instanceof Error ? error : new Error('HyperDHT worker startup failed'));
    }
  }
  private onWorkerMessage(worker: TransportWorker, message: FromWorker): void {
    if (this.#worker !== worker) return;
    if (message.type === 'started') { this.#publicKey = message.publicKey; const start = this.#start; this.#start = null; this.clearStartTimeout(); start?.resolve({ publicKey: message.publicKey }); return; }
    if (message.type === 'event') { for (const listener of this.#listeners) { try { listener(message.event); } catch { /* A subscriber cannot take down transport. */ } } return; }
    if (message.type === 'accepted' || message.type === 'rejected') {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.type === 'accepted') pending.resolve(); else pending.reject(new HyperDhtTransportError(message.code, `Transport send rejected: ${message.code}`));
      return;
    }
    if (message.type === 'fatal') this.fail(new Error(message.message));
  }
  private fail(error: Error, terminate = true): void {
    ++this.#generation;
    this.rejectStart(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    const worker = this.#worker;
    this.#worker = null; this.#publicKey = null;
    if (terminate && worker !== null) void worker.terminate();
  }
  private rejectStart(error: Error): void {
    const start = this.#start; this.#start = null; this.clearStartTimeout(); start?.reject(error);
  }
  private clearStartTimeout(): void {
    if (this.#startTimeout !== null) { clearTimeout(this.#startTimeout); this.#startTimeout = null; }
  }
  private isStarting(generation: number): boolean { return this.#generation === generation && this.#start !== null; }
  private assertKey(key: string): void { if (!KeySchema.safeParse(key).success) throw new Error('Invalid paired peer key'); }
  private validateOptions(): void {
    for (const node of this.#options.bootstrap) if (typeof node.host !== 'string' || node.host.length === 0 || !Number.isInteger(node.port) || node.port < 1 || node.port > 65_535) throw new Error('Invalid HyperDHT bootstrap node');
    if (this.#options.localPort !== undefined && (!Number.isInteger(this.#options.localPort) || this.#options.localPort < 1 || this.#options.localPort > 65_535)) throw new Error('Invalid HyperDHT local port');
    for (const value of [this.#options.maxConnections, this.#options.maxQueuedSends]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid HyperDHT capacity limit');
    if (!Number.isSafeInteger(this.#options.maxBufferedBytes) || this.#options.maxBufferedBytes < MAX_FRAME_BYTES) throw new Error('Invalid HyperDHT receive buffer limit');
    for (const value of [this.#options.connectionTimeoutMs, this.#options.startupTimeoutMs, this.#options.shutdownTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid HyperDHT timeout');
  }
}

export class HyperDhtTransportError extends Error {
  constructor(readonly code: 'PEER_OFFLINE' | 'INVALID_MESSAGE' | 'CAPACITY_EXCEEDED', message: string) { super(message); }
}
