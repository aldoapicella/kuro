import { z } from 'zod';
import { IDSchema, KeySchema } from './wire.js';

export const CORE_LIMITS = {
  maxSpaces: 32, maxImportBytes: 262144, maxCorpusBlocks: 40, maxBlockBytes: 1500,
  indexingBatchSize: 4, maxWaitingJobs: 5, maxPendingPerIdentity: 1,
  computationDeadlineMs: 120000, reviewRetentionMs: 86400000,
  vectorCandidates: 8, literalCandidates: 4,
  syncTimeoutMs: 10000, refreshIntervalMs: 60000, refreshJitterMs: 10000,
  issuanceIntervalMs: 5000, syncDedupRetentionMs: 86400000,
} as const;

export interface Clock {
  wallNowMs(): number;
  monotonicNowMs(): number;
}
/** Production implementations use cryptographic randomness. */
export interface IdSource { nextId(): string; randomUnit(): number }
export const SessionSchema = z.strictObject({
  memberId: IDSchema, deviceKey: KeySchema,
  validUntilMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type LocalSession = z.infer<typeof SessionSchema>;
/** Bound by the trusted host; no AppPort command accepts an acting identity. */
export interface SessionPort { current(): LocalSession | null }

export type SecretProtection = 'os-protected' | 'ephemeral-test' | 'unavailable' | 'basic_text';
export interface SecretStore {
  protection(): Promise<SecretProtection>;
  read(name: string): Promise<Uint8Array | null>;
  /** Atomically creates only if absent, across host processes. Returns the durably stored value,
   * including the existing winner of a concurrent creation. Never overwrites an identity. */
  createIfAbsent(name: string, candidate: Uint8Array): Promise<Uint8Array>;
}
export interface SelectedText {
  bytes: Uint8Array;
  mediaType: 'text/plain';
  /** Host-only local provenance. Must never enter wire messages or AppPort snapshots. */
  localPath: string | null;
}
/** Validates and reads the same file descriptor where possible; rejects symlinks/escapes. */
export interface SelectedFilePort { read(selectionId: string, maxBytes: number): Promise<SelectedText> }

export const VerifiedBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('authority'), spaceId: IDSchema, authorityKey: KeySchema, spaceAlias: IDSchema }),
  z.strictObject({ kind: z.literal('member'), spaceId: IDSchema, memberId: IDSchema, peerKey: KeySchema, spaceAlias: IDSchema }),
  z.strictObject({ kind: z.literal('peer'), spaceId: IDSchema, peerKey: KeySchema, spaceAlias: IDSchema }),
]);
export type VerifiedBinding = z.infer<typeof VerifiedBindingSchema>;
/** The trusted setup channel registers single-use tokens after out-of-band verification. */
export interface VerifiedPairingPort { consume(selectionId: string): Promise<VerifiedBinding> }

export type TransportEvent =
  | { type: 'message'; peerKey: string; bytes: Uint8Array }
  | { type: 'connected' | 'disconnected'; peerKey: string }
  | { type: 'error'; code: 'PEER_OFFLINE' | 'INVALID_MESSAGE' | 'CAPACITY_EXCEEDED' };
export interface TransportPort {
  start(): Promise<{ publicKey: string }>;
  stop(): Promise<void>;
  /** Resolves on transport acceptance, never on durable receipt. */
  send(peerKey: string, bytes: Uint8Array): Promise<void>;
  subscribe(listener: (event: TransportEvent) => void): () => void;
}
export const TransportMessageSchema = z.strictObject({
  type: z.literal('message'), peerKey: KeySchema, bytes: z.instanceof(Uint8Array).refine(b => b.byteLength > 0 && b.byteLength <= 32768),
});

/** Host lifecycle methods are intentionally separate from renderer-facing AppPort. */
export interface CoreLifecyclePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Synchronous barrier: close authorization before any suspend callback yields. */
  suspend(): void;
  /** Stale-state installation precedes reopening; host must establish clock validity. */
  resume(clockIsTrusted: boolean): Promise<void>;
  /** Service expired leases, retries and queue work. Does not approve reviews. */
  tick(): Promise<void>;
}
