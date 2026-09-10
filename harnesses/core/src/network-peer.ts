import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppCommands, VerifiedBindingSchema, decodeWire, digestBytes } from '@kuro/contracts';
import type { Result, TransportEvent, TransportPort, VerifiedBinding } from '@kuro/contracts';
import { openCore, secureIds, systemClock } from '@kuro/core';
import { FakeAiPort, FakePairing, FakeSession, MemorySelectedFiles } from '@kuro/core/testing';
import { HyperDhtTransport, InMemorySecretStore } from '@kuro/transport';

type Config = { stateDirectory: string; seedHex: string; pairedPeers: string[]; bootstrap: Array<{ host: string; port: number }>; memberId: string; localPort?: number };
type Command = { requestId: string; action: string; method?: string; input?: unknown; binding?: unknown; text?: unknown; available?: unknown; enabled?: unknown };
type WireRecord = { direction: 'in' | 'out' | 'dropped'; type: string; digest: string };

class DiagnosticTransport implements TransportPort {
  readonly #listeners = new Set<(event: TransportEvent) => void>();
  readonly #records: WireRecord[] = [];
  readonly #lifecycle: string[] = [];
  dropAck = false;
  droppedAcks = 0;
  constructor(private readonly transport: HyperDhtTransport) {
    transport.subscribe((event) => {
      if (event.type === 'message') this.record('in', event.bytes);
      else { this.#lifecycle.push(event.type === 'error' ? `error:${event.code}` : event.type); if (this.#lifecycle.length > 16) this.#lifecycle.shift(); }
      for (const listener of this.#listeners) listener(event);
    });
  }
  async start(): Promise<{ publicKey: string }> { return this.transport.start(); }
  async stop(): Promise<void> { await this.transport.stop(); }
  async send(peerKey: string, bytes: Uint8Array): Promise<void> {
    const message = safeWire(bytes);
    if (this.dropAck && message?.type === 'RESPONSE_ACK') { this.droppedAcks++; this.record('dropped', bytes); return; }
    this.record('out', bytes); await this.transport.send(peerKey, bytes);
  }
  subscribe(listener: (event: TransportEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  diagnostics(): { records: WireRecord[]; droppedAcks: number; lifecycle: string[] } { return { records: this.#records.slice(-32), droppedAcks: this.droppedAcks, lifecycle: [...this.#lifecycle] }; }
  private record(direction: WireRecord['direction'], bytes: Uint8Array): void { const message = safeWire(bytes); this.#records.push({ direction, type: message?.type ?? 'INVALID', digest: digestBytes(bytes) }); if (this.#records.length > 64) this.#records.shift(); }
}

function safeWire(bytes: Uint8Array): { type: string } | null { try { return decodeWire(bytes); } catch { return null; } }
function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function error(requestId: string | null, reason: unknown): void { output({ requestId, ok: false, error: reason instanceof Error ? reason.message : 'invalid command' }); }
function configFromEnvironment(): Config {
  const raw = process.env.KURO_CORE_PEER_CONFIG;
  if (!raw) throw new Error('KURO_CORE_PEER_CONFIG is required');
  const value = JSON.parse(raw) as Partial<Config>;
  if (typeof value.stateDirectory !== 'string' || !value.stateDirectory) throw new Error('stateDirectory is required');
  if (typeof value.seedHex !== 'string' || !/^[0-9a-f]{64}$/i.test(value.seedHex)) throw new Error('seedHex must be 32-byte hex');
  if (!Array.isArray(value.pairedPeers) || !value.pairedPeers.every(key => typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key))) throw new Error('pairedPeers must contain public keys');
  if (!Array.isArray(value.bootstrap) || !value.bootstrap.every(node => node && typeof node.host === 'string' && Number.isInteger(node.port) && node.port > 0 && node.port <= 65535)) throw new Error('bootstrap is invalid');
  if (typeof value.memberId !== 'string' || !/^[0-9a-f]{32}$/i.test(value.memberId)) throw new Error('memberId must be a 16-byte hex id');
  if (value.localPort !== undefined && (!Number.isInteger(value.localPort) || value.localPort < 1 || value.localPort > 65535)) throw new Error('localPort is invalid');
  return { stateDirectory: resolve(value.stateDirectory), seedHex: value.seedHex.toLowerCase(), pairedPeers: value.pairedPeers.map(key => key.toLowerCase()), bootstrap: value.bootstrap, memberId: value.memberId.toLowerCase(), ...(value.localPort === undefined ? {} : {localPort:value.localPort}) };
}

const config = configFromEnvironment();
mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
const secret = new InMemorySecretStore('ephemeral-test', new Map([['kuro.core.harness.vm.seed', Buffer.from(config.seedHex, 'hex')]]));
const baseTransport = new HyperDhtTransport({ secretStore: secret, secretName: 'kuro.core.harness.vm.seed', allowEphemeralTest: true, bootstrap: config.bootstrap, pairedPeers: config.pairedPeers, ...(config.localPort === undefined ? {} : {localPort:config.localPort}) });
const transport = new DiagnosticTransport(baseTransport);
const ai = new FakeAiPort();
const pairing = new FakePairing(secureIds);
const files = new MemorySelectedFiles(secureIds);
const started = await baseTransport.start();
const session = new FakeSession({ memberId: config.memberId, deviceKey: started.publicKey, validUntilMs: systemClock.wallNowMs() + 86_400_000 });
const core = await openCore({ databasePath: `${config.stateDirectory}/core.sqlite`, ai, transport, clock: systemClock, ids: secureIds, sessions: session, selectedFiles: files, pairing, clockInitiallyTrusted: true });
output({ type: 'ready', publicKey: started.publicKey, memberId: config.memberId, provider: 'simulatedAI+realHyperDHT', banner: 'SYNTHETIC TEST ONLY: FakeAiPort with real HyperDHT transport; no QVAC.' });

for await (const line of createInterface({ input: process.stdin })) {
  let command: Command;
  try { if (Buffer.byteLength(line)>300_000) throw new Error('command exceeds harness limit'); command = JSON.parse(line) as Command; if (typeof command.requestId !== 'string' || command.requestId.length > 128 || typeof command.action !== 'string') throw new Error('requestId and action are required'); }
  catch (reason) { error(null, reason); continue; }
  try {
    if (command.action === 'app') {
      if (typeof command.method !== 'string' || !Object.hasOwn(AppCommands,command.method)) throw new Error('unknown AppPort method');
      const app = core.app as unknown as Record<string, (input: unknown) => Promise<Result<unknown>>>;
      output({ requestId: command.requestId, result: await app[command.method]!(command.input) });
    } else if (command.action === 'verify') {
      const binding: VerifiedBinding = VerifiedBindingSchema.parse(command.binding);
      output({ requestId: command.requestId, selectionId: pairing.verify(binding) });
    } else if (command.action === 'selectText') {
      if (typeof command.text !== 'string' || new TextEncoder().encode(command.text).byteLength > 262144) throw new Error('text must be bounded UTF-8');
      output({ requestId: command.requestId, selectionId: files.add(command.text) });
    } else if (command.action === 'tick') {
      await core.tick(); await core.settled(); output({ requestId: command.requestId, ok: true });
    } else if (command.action === 'setAiAvailable') {
      if (typeof command.available !== 'boolean') throw new Error('available must be boolean'); ai.available = command.available; output({ requestId: command.requestId, available: ai.available });
    } else if (command.action === 'setDropAck') {
      if (typeof command.enabled !== 'boolean') throw new Error('enabled must be boolean'); transport.dropAck = command.enabled; output({ requestId: command.requestId, enabled: transport.dropAck });
    } else if (command.action === 'diagnostics') {
      output({ requestId: command.requestId, diagnostics: transport.diagnostics(), aiCalls: ai.calls.slice(-16).map(call => call.method) });
    } else if (command.action === 'stop') {
      await core.stop(); output({ requestId: command.requestId, stopped: true }); break;
    } else throw new Error('unknown action');
  } catch (reason) { error(command.requestId, reason); }
}
await core.stop().catch(() => {});
