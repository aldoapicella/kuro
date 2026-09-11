import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KuroError } from '@kuro/contracts';
import type { AiCapabilities, AiPort, ModelProfile, SecretStore, TransportPort } from '@kuro/contracts';
import { ProtectedSecretStore } from './secret-store.js';
import type { SecretProtector } from './secret-store.js';
import type { RealConfiguration } from './composition/real.js';

export type RuntimeProbeMode = 'runtime' | 'inference' | 'transport';
interface ProbeAiAdapter {
  port: Pick<AiPort, 'getCapabilities' | 'embedBlocks'>;
  profile: ModelProfile;
  close(): Promise<void>;
}
interface RuntimeProbeBaseOptions {
  protector: SecretProtector;
  operationTimeoutMs?: number;
}
export type RuntimeAiProbeOptions = RuntimeProbeBaseOptions & {
  mode: 'runtime' | 'inference';
  /** Test seam; production always uses the public @kuro/ai adapter below. */
  createAi?: () => Promise<ProbeAiAdapter>;
};
export type RuntimeTransportProbeOptions = RuntimeProbeBaseOptions & { mode: 'transport'; configuration: RealConfiguration };
export type RuntimeProbeOptions = RuntimeAiProbeOptions | RuntimeTransportProbeOptions;
interface RuntimeProbeBaseResult {
  status: 'passed';
  electron: string | null;
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  authorizationGate: 'closed';
}
export interface RuntimeAiProbeResult extends RuntimeProbeBaseResult {
  probe: 'runtime' | 'inference';
  storage: { protection: 'os-protected'; contenders: 8; concurrentWinner: true; reopenWinner: true };
  ai: { provider: 'qvac'; available: true; fallbackDownloads: false; operation: 'adapter-load-close' | 'cached-embedding'; modelId?: string; dimension?: number; vectors?: 1 };
  transport: { status: 'not-run'; reason: 'isolated-bootstrap-not-exposed-by-public-transport-api' };
}
export interface RuntimeTransportProbeResult extends RuntimeProbeBaseResult {
  probe: 'transport';
  storage: { protection: 'os-protected'; identities: 2; reopenWinner: true };
  ai: { status: 'not-run' };
  transport: { status: 'passed'; provider: 'bare-hyperdht'; deliveries: 5; authenticatedKeys: true; exactBytes: true; recipientReopen: true };
}
export type RuntimeProbeResult = RuntimeAiProbeResult | RuntimeTransportProbeResult;

const DEFAULT_OPERATION_TIMEOUT_MS = 105_000;
const CLOSE_TIMEOUT_MS = 10_000;
const TRANSPORT_CLEANUP_TIMEOUT_MS = 15_000;

/** Runs only synthetic, local host checks. It never opens core authorization. */
export function runRuntimeProbe(options: RuntimeAiProbeOptions): Promise<RuntimeAiProbeResult>;
export function runRuntimeProbe(options: RuntimeTransportProbeOptions): Promise<RuntimeTransportProbeResult>;
export async function runRuntimeProbe(options: RuntimeProbeOptions): Promise<RuntimeProbeResult> {
  if (options.mode === 'transport') return runTransportProbe(options);
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > DEFAULT_OPERATION_TIMEOUT_MS) throw new KuroError('INVALID_INPUT');
  if (await options.protector.protection() !== 'os-protected') throw new KuroError('IDENTITY_UNAVAILABLE');
  const deadline = Date.now() + operationTimeoutMs;

  const rawDirectory = await mkdtemp(join(tmpdir(), 'kuro-runtime-probe-'));
  let directory: string;
  try { directory = await realpath(rawDirectory); await chmod(directory, 0o700); }
  catch (error) { await rm(rawDirectory, { recursive: true, force: true }); throw error; }
  let ai: ProbeAiAdapter | undefined;
  try {
    const store = new ProtectedSecretStore(join(directory, 'secrets'), options.protector);
    const contenders = Array.from({ length: 8 }, (_, index) => new Uint8Array(32).fill(index + 1));
    const winners = await withinDeadline(Promise.all(contenders.map(candidate => store.createIfAbsent('runtime-probe-identity', candidate))), deadline, 'STORAGE_TIMEOUT');
    if (!winners.every(value => equal(value, winners[0]!))) throw new KuroError('IDENTITY_UNAVAILABLE');
    const reopened = await withinDeadline(new ProtectedSecretStore(join(directory, 'secrets'), options.protector).read('runtime-probe-identity'), deadline, 'STORAGE_TIMEOUT');
    if (reopened === null || !equal(reopened, winners[0]!)) throw new KuroError('IDENTITY_UNAVAILABLE');

    ai = await withinDeadline(options.createAi?.() ?? createActualAi(), deadline, 'AI_START_TIMEOUT');
    const capabilities = await withinDeadline(ai.port.getCapabilities(), deadline, 'AI_CAPABILITIES_TIMEOUT');
    requireQvac(capabilities);
    const aiResult: RuntimeProbeResult['ai'] = { provider: 'qvac', available: true, fallbackDownloads: false, operation: 'adapter-load-close' };
    if (options.mode === 'inference') {
      const jobId = '1'.repeat(32), blockId = '2'.repeat(32);
      const embedded = await withinDeadline(ai.port.embedBlocks({
        jobId,
        profile: ai.profile,
        blocks: [{ id: blockId, text: 'KURO synthetic authorized runtime probe evidence.', ref: null }],
      }), deadline, 'AI_INFERENCE_TIMEOUT');
      const vector = embedded.vectors[0];
      if (vector?.id !== blockId || vector.values.length !== ai.profile.dimension) throw new KuroError('INVALID_MODEL_OUTPUT');
      Object.assign(aiResult, { operation: 'cached-embedding' as const, modelId: embedded.profile.modelId, dimension: vector.values.length, vectors: 1 as const });
    }

    return {
      probe: options.mode, status: 'passed', electron: process.versions.electron ?? null, node: process.versions.node,
      platform: process.platform, arch: process.arch,
      storage: { protection: 'os-protected', contenders: 8, concurrentWinner: true, reopenWinner: true },
      ai: aiResult,
      transport: { status: 'not-run', reason: 'isolated-bootstrap-not-exposed-by-public-transport-api' },
      authorizationGate: 'closed',
    };
  } finally {
    try { if (ai !== undefined) await within(ai.close(), CLOSE_TIMEOUT_MS, 'AI_CLOSE_TIMEOUT'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}

async function runTransportProbe(options: RuntimeTransportProbeOptions): Promise<RuntimeTransportProbeResult> {
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > DEFAULT_OPERATION_TIMEOUT_MS) throw new KuroError('INVALID_INPUT');
  if (await options.protector.protection() !== 'os-protected') throw new KuroError('IDENTITY_UNAVAILABLE');
  const deadline = Date.now() + operationTimeoutMs;
  const rawDirectory = await mkdtemp(join(tmpdir(), 'kuro-transport-probe-'));
  let directory: string;
  try { directory = await realpath(rawDirectory); await chmod(directory, 0o700); }
  catch (error) { await rm(rawDirectory, { recursive: true, force: true }); throw error; }

  let left: (TransportPort & { pair(peerKey: string): void }) | undefined;
  let right: (TransportPort & { pair(peerKey: string): void }) | undefined;
  let result: RuntimeTransportProbeResult | undefined;
  let failure: unknown;
  try {
    const { HyperDhtTransport, runTransportConformance } = await withinDeadline(import('@kuro/transport'), deadline, 'TRANSPORT_START_TIMEOUT');
    const store = (name: string): SecretStore => new ProtectedSecretStore(join(directory, name), options.protector);
    const transportOptions = { bootstrap: options.configuration.bootstrap, startupTimeoutMs: 15_000, shutdownTimeoutMs: CLOSE_TIMEOUT_MS, connectionTimeoutMs: 10_000 };
    left = new HyperDhtTransport({ ...transportOptions, secretStore: store('left') });
    right = new HyperDhtTransport({ ...transportOptions, secretStore: store('right') });
    const [startedLeft, startedRight] = await withinDeadline(Promise.all([left.start(), right.start()]), deadline, 'TRANSPORT_START_TIMEOUT');
    left.pair(startedRight.publicKey); right.pair(startedLeft.publicKey);
    const conformance = await withinDeadline(runTransportConformance({
      sender: left, recipient: right, senderKey: startedLeft.publicKey, recipientKey: startedRight.publicKey,
      reconnectRecipient: async () => {
        await right!.stop();
        const reopened = await right!.start();
        if (reopened.publicKey !== startedRight.publicKey) throw new KuroError('IDENTITY_UNAVAILABLE');
      },
      timeoutMs: 10_000,
    }), deadline, 'TRANSPORT_CONFORMANCE_TIMEOUT');
    if (conformance.deliveries !== 5) throw new KuroError('INVALID_MESSAGE');
    result = {
      probe: 'transport', status: 'passed', electron: process.versions.electron ?? null, node: process.versions.node,
      platform: process.platform, arch: process.arch,
      storage: { protection: 'os-protected', identities: 2, reopenWinner: true },
      ai: { status: 'not-run' },
      transport: { status: 'passed', provider: 'bare-hyperdht', deliveries: 5, authenticatedKeys: true, exactBytes: true, recipientReopen: true },
      authorizationGate: 'closed',
    };
  } catch (error) { failure = error; }

  const stopped = await Promise.allSettled([left, right].filter((value): value is TransportPort & { pair(peerKey: string): void } => value !== undefined).map(value => within(value.stop(), TRANSPORT_CLEANUP_TIMEOUT_MS, 'TRANSPORT_CLOSE_TIMEOUT')));
  try { await rm(directory, { recursive: true, force: true }); }
  catch (error) { if (failure === undefined) failure = error; }
  if (failure !== undefined) throw failure;
  if (stopped.some(outcome => outcome.status === 'rejected')) throw new ProbeTimeoutError('TRANSPORT_CLOSE_FAILED');
  return result!;
}

export function runtimeProbeErrorCode(error: unknown): string {
  if (error instanceof KuroError) return error.code;
  if (error instanceof ProbeTimeoutError) return error.code;
  return 'RUNTIME_UNAVAILABLE';
}

async function createActualAi(): Promise<ProbeAiAdapter> {
  const { createAiAdapter, QvacClient, QVAC_EMBEDDING_PROFILE } = await import('@kuro/ai');
  const adapter = createAiAdapter(new QvacClient({ embeddingFallbackSrc: null, generationFallbackSrc: null }));
  return { port: adapter.port, profile: QVAC_EMBEDDING_PROFILE, close: () => adapter.close() };
}
function requireQvac(capabilities: AiCapabilities): void {
  if (capabilities.provider !== 'qvac' || !capabilities.available) throw new KuroError('MODEL_UNAVAILABLE');
}
function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
class ProbeTimeoutError extends Error { constructor(readonly code: string) { super(code); } }
async function within<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new ProbeTimeoutError(code)), timeoutMs); timer.unref(); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function withinDeadline<T>(operation: Promise<T>, deadline: number, code: string): Promise<T> {
  return within(operation, Math.max(1, deadline - Date.now()), code);
}
