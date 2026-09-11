import { failure, success } from '@kuro/contracts';
import type { DesktopHostPort, DesktopInfo } from '@kuro/contracts';

/** Compatibility for explicit demo/probe hosts; real setup is supplied by the host. */
export function unavailableSetup(info: DesktopInfo): Pick<DesktopHostPort,
  'getSetup' | 'saveProfile' | 'startWorkspace' | 'stopWorkspace' | 'prepareModel' | 'cancelModel' | 'exportInvitation' | 'exportEnrollment' | 'exportIdentity' | 'selectLinkedIdentity'> {
  return {
    getSetup: async () => success({ version: '0.1.0', sourceCommit: null, profile: info.profile,
      displayName: `Device ${info.profile}`, runtime: 'running', network: null,
      platform: process.platform, architecture: process.arch, clockProtection: info.clockProtection,
      localAddresses: [],
      secretProtection: info.mode === 'real' ? 'unavailable' : 'ephemeral-test',
      models: [], freeDiskBytes: null, embeddingProfile: null, error: null }),
    saveProfile: async () => failure('ACCESS_DENIED'), startWorkspace: async () => failure('ACCESS_DENIED'),
    stopWorkspace: async () => failure('ACCESS_DENIED'), prepareModel: async () => failure('MODEL_UNAVAILABLE'),
    cancelModel: async () => failure('MODEL_UNAVAILABLE'),
    exportInvitation: async () => failure('ACCESS_DENIED'), exportEnrollment: async () => failure('ACCESS_DENIED'),
    exportIdentity: async () => failure('ACCESS_DENIED'), selectLinkedIdentity: async () => failure('ACCESS_DENIED'),
  };
}
