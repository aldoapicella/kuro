import type { AppCommandName, AppInput, AppOutputs, AppPort, CommittedEvent, DesktopHostPort, Result } from '@kuro/contracts';

export type AppInvoker = <K extends AppCommandName>(name: K, input: AppInput<K>) => Promise<Result<AppOutputs[K]>>;
/** Only named domain functions cross contextBridge. The invoker stays in preload. */
export function createAppBridge(invoke: AppInvoker, subscribe: (listener: (event: CommittedEvent) => void) => () => void): AppPort {
  return Object.freeze({
    createSpace: i => invoke('createSpace', i), pairSpace: i => invoke('pairSpace', i),
    replaceAuthority: i => invoke('replaceAuthority', i), enrollMember: i => invoke('enrollMember', i),
    setMember: i => invoke('setMember', i), setRelationship: i => invoke('setRelationship', i),
    revokeDevice: i => invoke('revokeDevice', i), pairPeer: i => invoke('pairPeer', i), refreshSpace: i => invoke('refreshSpace', i),
    setLocalPolicy: i => invoke('setLocalPolicy', i), setDocumentRules: i => invoke('setDocumentRules', i),
    importText: i => invoke('importText', i), setIndexProfile: i => invoke('setIndexProfile', i),
    submitQuestion: i => invoke('submitQuestion', i), getState: i => invoke('getState', i), getSpaceAdministration: i => invoke('getSpaceAdministration', i), getLocalGrants: i => invoke('getLocalGrants', i), getDocumentRules: i => invoke('getDocumentRules', i),
    listReviews: i => invoke('listReviews', i), getReview: i => invoke('getReview', i),
    reviseDraft: i => invoke('reviseDraft', i), approveDraft: i => invoke('approveDraft', i),
    getEvidence: i => invoke('getEvidence', i), requestLocalSummary: i => invoke('requestLocalSummary', i),
    getSummary: i => invoke('getSummary', i), cancelJob: i => invoke('cancelJob', i), subscribe,
  } satisfies AppPort);
}
export interface DesktopBridge { app: AppPort; host: DesktopHostPort }
