import { z } from 'zod';
import { IDSchema, KeySchema } from './wire.js';
import { VerifiedBindingSchema } from './host.js';
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
export const DesktopCommands = {
  getInfo: z.strictObject({}),
  selectText: z.strictObject({}),
  selectPairing: z.strictObject({}),
  setScenario: z.strictObject({ scenario: DesktopScenarioSchema }),
} as const;
export const DesktopOutputSchemas = {
  getInfo: DesktopInfoSchema,
  selectText: z.strictObject({ selectionId: IDSchema, displayName: z.string().min(1).max(255) }).nullable(),
  selectPairing: z.strictObject({ selectionId: IDSchema, binding: VerifiedBindingSchema }).nullable(),
  setScenario: z.null(),
};
export type DesktopHostPort = {
  [K in keyof typeof DesktopCommands]: (input: z.infer<(typeof DesktopCommands)[K]>) =>
    Promise<Result<z.infer<(typeof DesktopOutputSchemas)[K]>>>;
};
