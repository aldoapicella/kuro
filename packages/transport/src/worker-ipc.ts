import { KeySchema, LIMITS, type TransportEvent } from '@kuro/contracts';
import type { FromWorker, ToWorker, WorkerConfig } from './worker-protocol.js';

// Private inherited pipe, separate from the public length-prefixed peer protocol.
// Hex keeps binary values lossless in both Node and Bare without Buffer.toJSON().
export const MAX_IPC_BYTES = 131_072;
export const MAX_PENDING_IPC_BYTES = MAX_IPC_BYTES * 32;
export const BARE_VERSION = '1.32.0';
export type HostCommand = ToWorker | { type: 'init'; config: WorkerConfig };
export type WorkerReply = FromWorker | { type: 'runtime'; version: string };

export function encodeIpc(message: HostCommand | WorkerReply): Uint8Array {
  let value: unknown = message;
  if (message.type === 'init') value = { ...message, config: { ...message.config, seed: hex(message.config.seed), port: message.config.port ?? null } };
  if (message.type === 'send') value = { ...message, bytes: hex(message.bytes) };
  if (message.type === 'event' && message.event.type === 'message') value = { ...message, event: { ...message.event, bytes: hex(message.event.bytes) } };
  const bytes = new TextEncoder().encode(JSON.stringify(value) + '\n');
  if (bytes.byteLength > MAX_IPC_BYTES) throw new Error('Network worker IPC frame exceeds limit');
  return bytes;
}

/** Bounded per-record accumulator, including partial and combined pipe reads. */
export class IpcDecoder {
  #buffer = new Uint8Array(0);
  push(chunk: Uint8Array, receive: (value: unknown) => void): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline + 1;
      const length = this.#buffer.length + end - start;
      if (length > MAX_IPC_BYTES) throw new Error('Network worker IPC frame exceeds limit');
      const joined = new Uint8Array(length);
      joined.set(this.#buffer); joined.set(chunk.subarray(start, end), this.#buffer.length);
      this.#buffer = joined;
      start = end;
      if (newline < 0) return;
      const record = this.#buffer;
      this.#buffer = new Uint8Array(0);
      receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record)) as unknown);
    }
  }
  finish(): void { if (this.#buffer.length !== 0) throw new Error('Truncated network worker IPC frame'); }
}

export function parseHostCommand(value: unknown): HostCommand {
  const m = object(value);
  switch (m.type) {
    case 'init': {
      fields(m, ['type', 'config']);
      const c = object(m.config);
      fields(c, ['seed', 'bootstrap', 'port', 'pairedPeers', 'maxConnections', 'maxBufferedBytes', 'maxQueuedSends', 'connectionTimeoutMs']);
      if (!Array.isArray(c.bootstrap) || !Array.isArray(c.pairedPeers)) throw invalid();
      return { type: 'init', config: {
        seed: unhex(c.seed, 32, 32),
        bootstrap: c.bootstrap.map((v: unknown) => { const b = object(v); fields(b, ['host', 'port']); return { host: string(b.host, 255), port: positive(b.port, 65_535) }; }),
        port: c.port === null ? undefined : positive(c.port, 65_535),
        pairedPeers: c.pairedPeers.map(key), maxConnections: positive(c.maxConnections),
        maxBufferedBytes: positive(c.maxBufferedBytes), maxQueuedSends: positive(c.maxQueuedSends),
        connectionTimeoutMs: positive(c.connectionTimeoutMs),
      } };
    }
    case 'send': fields(m, ['type', 'id', 'peerKey', 'bytes']); return { type: 'send', id: positive(m.id), peerKey: key(m.peerKey), bytes: unhex(m.bytes, 1, LIMITS.maxBodyBytes) };
    case 'pair': case 'remove-pair': fields(m, ['type', 'peerKey']); return { type: m.type, peerKey: key(m.peerKey) };
    case 'stop': fields(m, ['type']); return { type: 'stop' };
    default: throw invalid();
  }
}

export function parseWorkerReply(value: unknown): WorkerReply {
  const m = object(value);
  switch (m.type) {
    case 'runtime': fields(m, ['type', 'version']); return { type: 'runtime', version: string(m.version, 32) };
    case 'started': fields(m, ['type', 'publicKey']); return { type: 'started', publicKey: key(m.publicKey) };
    case 'accepted': fields(m, ['type', 'id']); return { type: 'accepted', id: positive(m.id) };
    case 'rejected': fields(m, ['type', 'id', 'code']); return { type: 'rejected', id: positive(m.id), code: code(m.code) };
    case 'event': fields(m, ['type', 'event']); return { type: 'event', event: event(m.event) };
    case 'stopped': fields(m, ['type']); return { type: 'stopped' };
    case 'fatal': fields(m, ['type', 'message']); return { type: 'fatal', message: string(m.message, 1024) };
    default: throw invalid();
  }
}
function event(value: unknown): TransportEvent {
  const e = object(value);
  if (e.type === 'message') { fields(e, ['type', 'peerKey', 'bytes']); return { type: e.type, peerKey: key(e.peerKey), bytes: unhex(e.bytes, 1, LIMITS.maxBodyBytes) }; }
  if (e.type === 'connected' || e.type === 'disconnected') { fields(e, ['type', 'peerKey']); return { type: e.type, peerKey: key(e.peerKey) }; }
  if (e.type === 'error') { fields(e, ['type', 'code']); return { type: e.type, code: code(e.code) }; }
  throw invalid();
}
function object(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(); return value as Record<string, unknown>; }
function fields(value: Record<string, unknown>, names: readonly string[]): void { if (Object.keys(value).length !== names.length || names.some(n => !Object.hasOwn(value, n))) throw invalid(); }
function key(value: unknown): string { return KeySchema.parse(value); }
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw invalid(); return value; }
function string(value: unknown, max: number): string { if (typeof value !== 'string' || value.length < 1 || value.length > max) throw invalid(); return value; }
function code(value: unknown): 'PEER_OFFLINE' | 'INVALID_MESSAGE' | 'CAPACITY_EXCEEDED' { if (value !== 'PEER_OFFLINE' && value !== 'INVALID_MESSAGE' && value !== 'CAPACITY_EXCEEDED') throw invalid(); return value; }
function hex(bytes: Uint8Array): string { return Buffer.from(bytes).toString('hex'); }
function unhex(value: unknown, min: number, max: number): Uint8Array { if (typeof value !== 'string' || value.length < min * 2 || value.length > max * 2 || !/^(?:[0-9a-f]{2})+$/.test(value)) throw invalid(); return new Uint8Array(Buffer.from(value, 'hex')); }
function invalid(): Error { return new Error('Invalid network worker IPC message'); }
