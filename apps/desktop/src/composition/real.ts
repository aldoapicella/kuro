import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openCore, SelectedTextFiles, secureIds, systemClock } from '@kuro/core';
import { HyperDhtTransport } from '@kuro/transport';
import { KuroError } from '@kuro/contracts';
import type { DesktopInfo, SecretStore } from '@kuro/contracts';
import type { QvacClientOptions } from '@kuro/ai';
import { VerifiedPairings } from '../selections.js';
import { LifecycleClock } from '../lifecycle-clock.js';
import { loadNativeClock } from '../native-clock.js';

export interface RealConfiguration { bootstrap: { host: string; port: number }[]; localPort?: number; bootstrapPort?: number }
export function readRealConfiguration(raw: unknown): RealConfiguration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new KuroError('INVALID_INPUT');
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some(k => !['bootstrap', 'localPort', 'bootstrapPort'].includes(k)) || !Array.isArray(record.bootstrap) || !record.bootstrap.length || record.bootstrap.length > 16) throw new KuroError('INVALID_INPUT');
  const port = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 65535;
  const bootstrap = record.bootstrap.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new KuroError('INVALID_INPUT');
    const node = item as Record<string, unknown>;
    if (Object.keys(node).sort().join(',') !== 'host,port' || typeof node.host !== 'string' || !/^[a-zA-Z0-9.:-]{1,253}$/.test(node.host) || !port(node.port)) throw new KuroError('INVALID_INPUT');
    return { host: node.host, port: node.port };
  });
  if (record.localPort !== undefined && !port(record.localPort)) throw new KuroError('INVALID_INPUT');
  if (record.bootstrapPort !== undefined && !port(record.bootstrapPort)) throw new KuroError('INVALID_INPUT');
  return { bootstrap, ...(record.localPort === undefined ? {} : { localPort: record.localPort as number }), ...(record.bootstrapPort === undefined ? {} : { bootstrapPort: record.bootstrapPort as number }) };
}

export async function createRealDesktop(directory: string, profile: 'A' | 'B', secretStore: SecretStore, configuration: RealConfiguration, localModelPath?: QvacClientOptions['localModelPath']) {
  if (await secretStore.protection() !== 'os-protected') throw new KuroError('IDENTITY_UNAVAILABLE');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const memberBytes = await secretStore.createIfAbsent('kuro.local.member.v1', new Uint8Array(randomBytes(16)));
  if (memberBytes.length !== 16) throw new KuroError('IDENTITY_UNAVAILABLE');
  const transport = new HyperDhtTransport({ secretStore, ...configuration });
  let closeAi: (() => Promise<void>) | undefined;
  try {
    const identity = await transport.start();
    // Loading this module is explicit; a failed SDK/worker never switches to FakeAiPort.
    const { createAiAdapter, QvacClient } = await import('@kuro/ai');
    const ai = createAiAdapter(new QvacClient({ embeddingFallbackSrc: null, generationFallbackSrc: null, ...(localModelPath ? { localModelPath } : {}) }));
    closeAi = () => ai.close();
    const files = new SelectedTextFiles(), pairing = new VerifiedPairings();
    const memberId = Buffer.from(memberBytes).toString('hex');
    let clock: LifecycleClock | undefined;
    try { clock = new LifecycleClock(loadNativeClock()); } catch { /* Unqualified hosts remain explicitly closed. */ }
    const core = await openCore({ databasePath: join(directory, 'kuro.sqlite'), ai: ai.port, transport, clock: clock ?? systemClock, ids: secureIds, sessions: { current: () => ({ memberId, deviceKey: identity.publicKey, validUntilMs: Number.MAX_SAFE_INTEGER }) }, selectedFiles: files, pairing, clockInitiallyTrusted: clock !== undefined });
    const info: DesktopInfo = { mode: 'real', profile, memberId, publicKey: identity.publicKey, peers: [], scenario: null, clockProtection: clock ? 'native' : 'closed' };
    return { core, app: core.app, files, pairing, info, transport, ai, clock };
  } catch (error) {
    await Promise.allSettled([transport.stop(), closeAi?.() ?? Promise.resolve()]);
    throw error;
  }
}
