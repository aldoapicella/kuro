import { z } from 'zod';
import { IDSchema, KeySchema, DigestSchema, CapabilitySchema, PassageSchema, ConditionsSchema } from './wire.js';
import { ModelProfileSchema } from './ai.js';
import type { Result } from './errors.js';

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const validity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const capabilities = z.array(CapabilitySchema).max(5).refine(values => new Set(values).size === values.length);
export const DocumentRuleSchema = z.strictObject({ memberId: IDSchema, actions: capabilities, validUntilMs: validity });
export type DocumentRule = z.infer<typeof DocumentRuleSchema>;
export const RequestStateSchema = z.enum(['OUTGOING', 'RECEIVED', 'QUEUED', 'RETRIEVING', 'REVIEW', 'APPROVED', 'EVIDENCE_READY', 'CLOSED', 'CANCELLED', 'EXPIRED', 'FAILED']);
export const DeliveryStateSchema = z.enum(['OUTBOX_READY', 'DISPATCHING', 'RETRY_WAIT', 'ACKED', 'CANCELLED', 'EXPIRED']);
export const JobStateSchema = z.enum(['QUEUED', 'RUNNING', 'COMPLETE', 'CANCELLED', 'EXPIRED', 'FAILED']);
export const SummaryStateSchema = z.enum(['SUMMARY_PENDING', 'RUNNING', 'DRAFT', 'CANCELLED', 'EXPIRED', 'FAILED']);
export const SpaceSyncStateSchema = z.enum(['UNPAIRED', 'SYNCING', 'CURRENT', 'OFFLINE_VALID', 'EXPIRED', 'DENIED', 'STALE']);
export const IngestionStateSchema = z.enum(['PENDING', 'COMPLETE', 'PARTIAL', 'FAILED']);
export const SpaceViewSchema = z.strictObject({
  spaceId: IDSchema, authorityKey: KeySchema, isOwner: z.boolean(),
  policyRevision: revision, policyEpoch: revision, corpusRevision: revision, indexGeneration: revision,
  syncState: SpaceSyncStateSchema, lastSyncMs: validity, remainingValidityMs: revision,
});
export type SpaceView = z.infer<typeof SpaceViewSchema>;
const DeviceAdministrationSchema = z.strictObject({ publicKey: KeySchema, spaceAlias: IDSchema, revoked: z.boolean() });
const MemberAdministrationSchema = z.strictObject({ memberId: IDSchema, active: z.boolean(), capabilities, validUntilMs: validity, devices: z.array(DeviceAdministrationSchema).max(4) });
const RelationshipAdministrationSchema = z.strictObject({ memberId: IDSchema, otherMemberId: IDSchema, allowed: z.boolean(), validUntilMs: validity });
const ProjectionMemberSchema = z.strictObject({ memberId: IDSchema, capabilities, deviceKeys: z.array(KeySchema).min(1).max(4) });
/** Fails CLOCK_UNCERTAIN without a trusted lifecycle clock; recipient reads require the bound local session in a current projection and fail EXPIRED when its lease is stale. */
export const SpaceAdministrationSchema = z.discriminatedUnion('scope', [
  z.strictObject({ space: SpaceViewSchema, scope: z.literal('owner'), tombstoned: z.boolean(), members: z.array(MemberAdministrationSchema).max(16), relationships: z.array(RelationshipAdministrationSchema).max(120) }),
  z.strictObject({ space: SpaceViewSchema, scope: z.literal('recipient-projection'), members: z.array(ProjectionMemberSchema).max(16) }),
]);
export type SpaceAdministration = z.infer<typeof SpaceAdministrationSchema>;
export const LocalGrantSchema = z.strictObject({ memberId: IDSchema, admitted: z.boolean(), actions: capabilities, validUntilMs: validity });
/** Only a current local administrator can read or edit these rows; it fails CLOCK_UNCERTAIN or EXPIRED before exposing them. */
export const LocalGrantsViewSchema = z.strictObject({ spaceId: IDSchema, policyEpoch: revision, canEdit: z.literal(true), grants: z.array(LocalGrantSchema).max(16) });
export type LocalGrantsView = z.infer<typeof LocalGrantsViewSchema>;
/** Only a current local administrator can read document rules; it fails CLOCK_UNCERTAIN or EXPIRED before exposing them. */
export const DocumentRulesViewSchema = z.strictObject({ spaceId: IDSchema, documentId: IDSchema, revision, rules: z.array(DocumentRuleSchema).max(16) });
export type DocumentRulesView = z.infer<typeof DocumentRulesViewSchema>;
export const ReviewViewSchema = z.strictObject({
  draftId: IDSchema, requestId: IDSchema, spaceId: IDSchema, revision,
  recipientKey: KeySchema, question: z.string().max(2048),
  passages: z.array(PassageSchema).max(6), selectedSpanIds: z.array(IDSchema).max(6),
  conditions: ConditionsSchema, policyEpoch: revision, corpusRevision: revision, indexGeneration: revision,
  coverage: z.enum(['COMPLETE', 'PARTIAL', 'EMPTY']), expiresAtMs: revision, viewDigest: DigestSchema,
});
export type ReviewView = z.infer<typeof ReviewViewSchema>;
export const EvidenceViewSchema = z.strictObject({
  responseId: IDSchema, requestId: IDSchema, spaceId: IDSchema, senderKey: KeySchema,
  question: z.string().max(2048), passages: z.array(PassageSchema).min(1).max(6), conditions: ConditionsSchema,
  receivedAtMs: revision, expiresAtMs: revision, bodyDigest: DigestSchema,
});
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;
export const SummaryViewSchema = z.strictObject({
  summaryId: IDSchema, responseId: IDSchema, state: SummaryStateSchema,
  preparationDigest: DigestSchema.nullable(), requiresSemanticReview: z.literal(true),
  claims: z.array(z.strictObject({ text: z.string().max(400), quotes: z.array(PassageSchema).max(4) })).max(4),
});
export type SummaryView = z.infer<typeof SummaryViewSchema>;
export const CommittedEventSchema = z.strictObject({
  entity: z.enum(['space', 'document', 'request', 'review', 'delivery', 'evidence', 'summary', 'job']), id: IDSchema, revision,
});
export type CommittedEvent = z.infer<typeof CommittedEventSchema>;
export const StateViewSchema = z.strictObject({
  clockEpochValid: z.boolean(), spaces: z.array(SpaceViewSchema).max(32),
  requests: z.array(z.strictObject({ requestId: IDSchema, spaceId: IDSchema, state: RequestStateSchema })).max(256),
  jobs: z.array(z.strictObject({ jobId: IDSchema, state: JobStateSchema })).max(256),
  evidenceIds: z.array(IDSchema).max(256),
  documents: z.array(z.strictObject({ documentId: IDSchema, spaceId: IDSchema, revision, ingestionState: IngestionStateSchema })).max(256),
  summaries: z.array(z.strictObject({ summaryId: IDSchema, state: SummaryStateSchema })).max(256),
});
export type StateView = z.infer<typeof StateViewSchema>;

/** Schemas for local IPC only. These commands are never accepted from the peer protocol. */
export const AppCommands = {
  createSpace: z.strictObject({ capabilities, localActions: capabilities }),
  pairSpace: z.strictObject({ selectionId: IDSchema, localActions: capabilities }),
  replaceAuthority: z.strictObject({ oldSpaceId: IDSchema, selectionId: IDSchema, expectedRevision: revision, capabilities, localActions: capabilities }),
  enrollMember: z.strictObject({ spaceId: IDSchema, selectionId: IDSchema, capabilities, validUntilMs: validity, expectedRevision: revision }),
  setMember: z.strictObject({ spaceId: IDSchema, memberId: IDSchema, active: z.boolean(), capabilities, validUntilMs: validity, expectedRevision: revision }),
  setRelationship: z.strictObject({ spaceId: IDSchema, memberId: IDSchema, otherMemberId: IDSchema, allowed: z.boolean(), validUntilMs: validity, expectedRevision: revision }),
  revokeDevice: z.strictObject({ spaceId: IDSchema, publicKey: KeySchema, expectedRevision: revision }),
  pairPeer: z.strictObject({ selectionId: IDSchema }),
  refreshSpace: z.strictObject({ spaceId: IDSchema }),
  setLocalPolicy: z.strictObject({ spaceId: IDSchema, memberId: IDSchema, admitted: z.boolean(), actions: capabilities, validUntilMs: validity, expectedRevision: revision }),
  setDocumentRules: z.strictObject({ spaceId: IDSchema, documentId: IDSchema, rules: z.array(DocumentRuleSchema).max(16), expectedRevision: revision }),
  importText: z.strictObject({ spaceId: IDSchema, selectionId: IDSchema, replaceDocumentId: IDSchema.nullable(), expectedRevision: revision.nullable(), rules: z.array(DocumentRuleSchema).max(16) }),
  setIndexProfile: z.strictObject({ spaceId: IDSchema, profile: ModelProfileSchema, expectedRevision: revision }),
  submitQuestion: z.strictObject({ spaceId: IDSchema, custodianKey: KeySchema, query: z.string().min(1).refine(q => new TextEncoder().encode(q).length <= 2048), ttlSeconds: z.number().int().min(1).max(86400) }),
  getState: z.strictObject({}),
  getSpaceAdministration: z.strictObject({ spaceId: IDSchema }),
  getLocalGrants: z.strictObject({ spaceId: IDSchema }),
  getDocumentRules: z.strictObject({ spaceId: IDSchema, documentId: IDSchema }),
  listReviews: z.strictObject({ spaceId: IDSchema }),
  getReview: z.strictObject({ draftId: IDSchema }),
  reviseDraft: z.strictObject({ draftId: IDSchema, expectedRevision: revision, reviewedViewDigest: DigestSchema, selectedSpanIds: z.array(IDSchema).min(1).max(6), conditions: ConditionsSchema }),
  approveDraft: z.strictObject({ draftId: IDSchema, expectedRevision: revision, reviewedViewDigest: DigestSchema }),
  getEvidence: z.strictObject({ responseId: IDSchema }),
  requestLocalSummary: z.strictObject({ responseId: IDSchema }),
  getSummary: z.strictObject({ summaryId: IDSchema }),
  cancelJob: z.strictObject({ jobId: IDSchema }),
} as const;
export type AppCommandName = keyof typeof AppCommands;
export type AppInput<K extends AppCommandName> = z.infer<(typeof AppCommands)[K]>;
export interface AppOutputs {
  createSpace: SpaceView; pairSpace: SpaceView; replaceAuthority: SpaceView; enrollMember: SpaceView; setMember: SpaceView;
  setRelationship: SpaceView; revokeDevice: SpaceView; pairPeer: null; refreshSpace: { requestId: string };
  setLocalPolicy: SpaceView; setDocumentRules: { revision: number };
  importText: { documentId: string; versionId: string; jobId: string; revision: number };
  setIndexProfile: { jobId: string }; submitQuestion: { requestId: string };
  getSpaceAdministration: SpaceAdministration; getLocalGrants: LocalGrantsView; getDocumentRules: DocumentRulesView;
  getState: StateView; listReviews: ReviewView[]; getReview: ReviewView; reviseDraft: ReviewView;
  approveDraft: { responseId: string }; getEvidence: EvidenceView;
  requestLocalSummary: { summaryId: string; jobId: string }; getSummary: SummaryView; cancelJob: null;
}
/** Validated host-to-renderer replies. Existing AppPort inputs and semantics are unchanged. */
export const AppOutputSchemas = {
  createSpace: SpaceViewSchema, pairSpace: SpaceViewSchema, replaceAuthority: SpaceViewSchema,
  enrollMember: SpaceViewSchema, setMember: SpaceViewSchema, setRelationship: SpaceViewSchema, revokeDevice: SpaceViewSchema,
  pairPeer: z.null(), refreshSpace: z.strictObject({ requestId: IDSchema }),
  setLocalPolicy: SpaceViewSchema, setDocumentRules: z.strictObject({ revision }),
  importText: z.strictObject({ documentId: IDSchema, versionId: IDSchema, jobId: IDSchema, revision }),
  setIndexProfile: z.strictObject({ jobId: IDSchema }), submitQuestion: z.strictObject({ requestId: IDSchema }),
  getSpaceAdministration: SpaceAdministrationSchema, getLocalGrants: LocalGrantsViewSchema, getDocumentRules: DocumentRulesViewSchema,
  getState: StateViewSchema, listReviews: z.array(ReviewViewSchema).max(256),
  getReview: ReviewViewSchema, reviseDraft: ReviewViewSchema,
  approveDraft: z.strictObject({ responseId: IDSchema }), getEvidence: EvidenceViewSchema,
  requestLocalSummary: z.strictObject({ summaryId: IDSchema, jobId: IDSchema }),
  getSummary: SummaryViewSchema, cancelJob: z.null(),
} satisfies { [K in AppCommandName]: z.ZodType<AppOutputs[K]> };
export type AppPort = {
  [K in AppCommandName]: (input: AppInput<K>) => Promise<Result<AppOutputs[K]>>;
} & { subscribe(listener: (event: CommittedEvent) => void): () => void };
