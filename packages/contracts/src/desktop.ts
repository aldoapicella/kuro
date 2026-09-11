import { z } from 'zod';
import { IDSchema, KeySchema } from './wire.js';
import { VerifiedBindingSchema } from './host.js';
import { ErrorCodeSchema } from './errors.js';
import { ModelProfileSchema } from './ai.js';
import type { Result } from './errors.js';

/** Trusted local OS actions, separate from domain AppPort and never accepted over P2P. */
export const DesktopScenarioSchema = z.enum([
  'ready', 'waiting', 'offline', 'expired', 'stale-review', 'model-unavailable', 'capacity', 'error',
]);
export type DesktopScenario = z.infer<typeof DesktopScenarioSchema>;
export const DesktopInfoSchema = z.strictObject({
  mode: z.enum(['demo', 'core-simulated', 'real']), profile: z.enum(['A', 'B']),
  memberId: IDSchema, publicKey: KeySchema, scenario: DesktopScenarioSchema.nullable(),
  peers: z.array(z.strictObject({ memberId: IDSchema.nullable(), publicKey: KeySchema })).max(32),
  clockProtection: z.enum(['simulated', 'closed', 'native']),
});
export type DesktopInfo = z.infer<typeof DesktopInfoSchema>;
const port = z.number().int().min(1).max(65535);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DesktopNetworkSchema = z.strictObject({
  bootstrap: z.array(z.strictObject({ host: z.string().regex(/^[a-zA-Z0-9.:-]{1,253}$/), port })).min(1).max(8),
  localPort: port.nullable(),
  /** Host a private LAN bootstrap on this device; never enable public discovery implicitly. */
  bootstrapPort: port.nullable(),
});
export type DesktopNetwork = z.infer<typeof DesktopNetworkSchema>;
export const DesktopModelKindSchema = z.enum(['embedding', 'summary']);
export type DesktopModelKind = z.infer<typeof DesktopModelKindSchema>;
export const DesktopModelStateSchema = z.strictObject({
  kind: DesktopModelKindSchema, name: z.string().min(1).max(128), bytes,
  sha256: z.string().regex(/^[0-9a-f]{64}$/), downloadedBytes: bytes,
  state: z.enum(['missing', 'checking', 'downloading', 'verifying', 'ready', 'cancelled', 'failed']),
  error: z.enum(['NETWORK_FAILURE', 'INSUFFICIENT_DISK', 'CHECKSUM_MISMATCH', 'STORAGE_FAILURE']).nullable(),
});
export type DesktopModelState = z.infer<typeof DesktopModelStateSchema>;
export const DesktopSetupSchema = z.strictObject({
  version: z.string().min(1).max(64), sourceCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  profile: z.enum(['A', 'B']), displayName: z.string().min(1).max(64).nullable(),
  runtime: z.enum(['unconfigured', 'stopped', 'starting', 'running', 'failed']),
  network: DesktopNetworkSchema.nullable(),
  platform: z.string().min(1).max(64), architecture: z.string().min(1).max(32),
  localAddresses: z.array(z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}$/)).max(16),
  clockProtection: z.enum(['simulated', 'closed', 'native']),
  secretProtection: z.enum(['os-protected', 'ephemeral-test', 'unavailable', 'basic_text']),
  models: z.array(DesktopModelStateSchema).max(2), freeDiskBytes: bytes.nullable(),
  embeddingProfile: ModelProfileSchema.nullable(),
  error: ErrorCodeSchema.nullable(),
});
export type DesktopSetup = z.infer<typeof DesktopSetupSchema>;
/** Content-free setup/recovery remains available when protected domain access is closed. */
export const DESKTOP_RECOVERY_COMMANDS: ReadonlySet<string> = new Set([
  'getSetup', 'saveProfile', 'startWorkspace', 'stopWorkspace', 'prepareModel', 'cancelModel', 'selectLinkedIdentity',
]);
export const DesktopCommands = {
  getInfo: z.strictObject({}),
  selectText: z.strictObject({}),
  selectPairing: z.strictObject({}),
  setScenario: z.strictObject({ scenario: DesktopScenarioSchema }),
  getSetup: z.strictObject({}),
  saveProfile: z.strictObject({ displayName: z.string().trim().min(1).max(64), network: DesktopNetworkSchema }),
  startWorkspace: z.strictObject({}),
  stopWorkspace: z.strictObject({}),
  prepareModel: z.strictObject({ kind: DesktopModelKindSchema }),
  cancelModel: z.strictObject({ kind: DesktopModelKindSchema }),
  exportInvitation: z.strictObject({ spaceId: IDSchema }),
  exportEnrollment: z.strictObject({ spaceId: IDSchema }),
  exportIdentity: z.strictObject({}),
  selectLinkedIdentity: z.strictObject({}),
} as const;
export const DesktopOutputSchemas = {
  getInfo: DesktopInfoSchema,
  selectText: z.strictObject({ selectionId: IDSchema, displayName: z.string().min(1).max(255) }).nullable(),
  selectPairing: z.strictObject({ selectionId: IDSchema, binding: VerifiedBindingSchema }).nullable(),
  setScenario: z.null(),
  getSetup: DesktopSetupSchema,
  saveProfile: z.null(), startWorkspace: z.null(), stopWorkspace: z.null(),
  prepareModel: z.null(), cancelModel: z.null(),
  exportInvitation: z.strictObject({ displayName: z.string().min(1).max(255) }).nullable(),
  exportEnrollment: z.strictObject({ displayName: z.string().min(1).max(255) }).nullable(),
  exportIdentity: z.strictObject({ displayName: z.string().min(1).max(255) }).nullable(),
  selectLinkedIdentity: z.strictObject({ memberId: IDSchema, sourceKey: KeySchema }).nullable(),
};
export type DesktopHostPort = {
  [K in keyof typeof DesktopCommands]: (input: z.infer<(typeof DesktopCommands)[K]>) =>
    Promise<Result<z.infer<(typeof DesktopOutputSchemas)[K]>>>;
};
