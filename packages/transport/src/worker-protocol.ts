export interface WorkerBootstrap { host: string; port: number }
export interface WorkerConfig {
  seed: Uint8Array;
  bootstrap: readonly WorkerBootstrap[];
  port: number | undefined;
  pairedPeers: readonly string[];
  maxConnections: number;
  maxBufferedBytes: number;
  maxQueuedSends: number;
  connectionTimeoutMs: number;
}
export type ToWorker =
  | { type: 'send'; id: number; peerKey: string; bytes: Uint8Array }
  | { type: 'pair' | 'remove-pair'; peerKey: string }
  | { type: 'stop' };
export type FromWorker =
  | { type: 'started'; publicKey: string }
  | { type: 'accepted'; id: number }
  | { type: 'rejected'; id: number; code: 'PEER_OFFLINE' | 'INVALID_MESSAGE' | 'CAPACITY_EXCEEDED' }
  | { type: 'event'; event: import('@kuro/contracts').TransportEvent }
  | { type: 'stopped' }
  | { type: 'fatal'; message: string };
