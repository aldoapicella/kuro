/** Scripted desktop-only scenarios. These are never used as an adapter fallback. */
import { AppCommands, KuroError, canonicalDigest, failure, success } from '@kuro/contracts';
import type { AppCommandName, AppInput, AppOutputs, AppPort, CommittedEvent, DesktopInfo, DesktopScenario, EvidenceView, ReviewView, SpaceView, StateView, SummaryView } from '@kuro/contracts';

export const demoId = (n: number): string => n.toString(16).padStart(32, '0');
export const DEMO_OWNER = { memberId: '1'.repeat(32), publicKey: 'a'.repeat(64) };
export const DEMO_REQUESTER = { memberId: '2'.repeat(32), publicKey: 'b'.repeat(64) };
export const DEMO_TEXT = 'The KURO pilot remains provisional. Release requires a signed human review; the September checkpoint alone does not authorize publication.';

export class FakeAppPort {
  readonly app: AppPort;
  readonly calls: { name: AppCommandName; input: unknown }[] = [];
  scenario: DesktopScenario = 'ready';
  private sequence = 100;
  private state!: StateView;
  private reviews = new Map<string, ReviewView>();
  private evidence = new Map<string, EvidenceView>();
  private summaries = new Map<string, SummaryView>();
  private listeners = new Set<(event: CommittedEvent) => void>();
  private closed = false;
  constructor(readonly profile: 'A' | 'B' = 'A', private readonly now: () => number = Date.now) {
    const bind = <K extends AppCommandName>(name: K, operation: (input: AppInput<K>) => AppOutputs[K] | Promise<AppOutputs[K]>) => async (input: AppInput<K>) => {
      this.calls.push({ name, input: structuredClone(input) });
      const parsed = AppCommands[name].safeParse(input);
      if (!parsed.success) return failure('INVALID_INPUT');
      if (this.closed) return failure('CANCELLED');
      if (this.scenario === 'error' && name !== 'getState') return failure('STORAGE_FAILURE');
      try { return success(structuredClone(await operation(parsed.data as AppInput<K>))); }
      catch (error) { return failure(error instanceof KuroError ? error.code : 'STORAGE_FAILURE'); }
    };
    const admin = (spaceId: string, expected: number, local = false): SpaceView => {
      const space = this.space(spaceId);
      if ((local ? space.policyEpoch : space.policyRevision) !== expected) throw new KuroError('STALE_REVISION');
      space.policyEpoch++; if (!local) space.policyRevision++;
      this.notify('space', spaceId, space.policyRevision); return space;
    };
    this.app = {
      createSpace: bind('createSpace', () => { const space = this.newSpace(this.next()); this.state.spaces.push(space); this.notify('space', space.spaceId); return space; }),
      pairSpace: bind('pairSpace', () => { const space = this.newSpace(this.next()); space.isOwner = false; this.state.spaces.push(space); this.notify('space', space.spaceId); return space; }),
      replaceAuthority: bind('replaceAuthority', () => { throw new KuroError('ACCESS_DENIED'); }),
      enrollMember: bind('enrollMember', i => admin(i.spaceId, i.expectedRevision)),
      setMember: bind('setMember', i => admin(i.spaceId, i.expectedRevision)),
      setRelationship: bind('setRelationship', i => admin(i.spaceId, i.expectedRevision)),
      revokeDevice: bind('revokeDevice', i => admin(i.spaceId, i.expectedRevision)),
      pairPeer: bind('pairPeer', () => null),
      refreshSpace: bind('refreshSpace', i => { if (this.scenario === 'offline') throw new KuroError('PEER_OFFLINE'); const space = this.space(i.spaceId); space.syncState = 'CURRENT'; space.remainingValidityMs = 900000; this.notify('space', i.spaceId); return { requestId: this.next() }; }),
      setLocalPolicy: bind('setLocalPolicy', i => admin(i.spaceId, i.expectedRevision, true)),
      setDocumentRules: bind('setDocumentRules', i => { const doc = this.state.documents.find(d => d.documentId === i.documentId && d.spaceId === i.spaceId); if (!doc || doc.revision !== i.expectedRevision) throw new KuroError('STALE_REVISION'); doc.revision++; this.notify('document', doc.documentId, doc.revision); return { revision: doc.revision }; }),
      importText: bind('importText', i => { this.space(i.spaceId); const documentId = this.next(), jobId = this.next(); this.state.documents.push({ documentId, spaceId: i.spaceId, revision: 0, ingestionState: 'COMPLETE' }); this.state.jobs.push({ jobId, state: 'COMPLETE' }); this.notify('document', documentId); return { documentId, versionId: this.next(), jobId, revision: 0 }; }),
      setIndexProfile: bind('setIndexProfile', i => { this.space(i.spaceId); const jobId = this.next(); this.state.jobs.push({ jobId, state: 'COMPLETE' }); return { jobId }; }),
      submitQuestion: bind('submitQuestion', i => {
        this.space(i.spaceId);
        if (this.scenario === 'offline') throw new KuroError('PEER_OFFLINE');
        if (this.scenario === 'capacity') throw new KuroError('CAPACITY_EXCEEDED');
        const requestId = this.next();
        this.state.requests.push({ requestId, spaceId: i.spaceId, state: this.scenario === 'waiting' ? 'QUEUED' : 'REVIEW' });
        if (this.scenario !== 'waiting') { const review = this.newReview(requestId, i.spaceId, i.query); this.reviews.set(review.draftId, review); }
        this.notify('request', requestId); return { requestId };
      }),
      getState: bind('getState', () => this.state),
      getSpaceAdministration: bind('getSpaceAdministration', i => ({ space: this.space(i.spaceId), scope: 'owner', tombstoned: false, members: [{ memberId: DEMO_OWNER.memberId, active: true, capabilities: ['search', 'read', 'share', 'receive', 'manage'], validUntilMs: null, devices: [{ publicKey: DEMO_OWNER.publicKey, spaceAlias: demoId(10), revoked: false }] }, { memberId: DEMO_REQUESTER.memberId, active: true, capabilities: ['search', 'read', 'share', 'receive', 'manage'], validUntilMs: null, devices: [{ publicKey: DEMO_REQUESTER.publicKey, spaceAlias: demoId(11), revoked: false }] }], relationships: [{ memberId: DEMO_OWNER.memberId, otherMemberId: DEMO_REQUESTER.memberId, allowed: true, validUntilMs: null }] })),
      getLocalGrants: bind('getLocalGrants', i => ({ spaceId: i.spaceId, policyEpoch: this.space(i.spaceId).policyEpoch, canEdit: true, grants: [{ memberId: DEMO_OWNER.memberId, admitted: true, actions: ['search', 'read', 'share', 'receive', 'manage'], validUntilMs: null }, { memberId: DEMO_REQUESTER.memberId, admitted: true, actions: ['search', 'read', 'share', 'receive', 'manage'], validUntilMs: null }] })),
      getDocumentRules: bind('getDocumentRules', i => { const document = this.state.documents.find(d => d.spaceId === i.spaceId && d.documentId === i.documentId); if (!document) throw new KuroError('ACCESS_DENIED'); return { spaceId: i.spaceId, documentId: i.documentId, revision: document.revision, rules: [{ memberId: DEMO_OWNER.memberId, actions: ['search', 'read', 'share', 'receive', 'manage'], validUntilMs: null }, { memberId: DEMO_REQUESTER.memberId, actions: ['receive'], validUntilMs: null }] }; }),
      listReviews: bind('listReviews', i => { this.space(i.spaceId); return [...this.reviews.values()].filter(r => r.spaceId === i.spaceId); }),
      getReview: bind('getReview', i => this.review(i.draftId)),
      reviseDraft: bind('reviseDraft', i => {
        const review = this.review(i.draftId); this.requireRevision(review, i.expectedRevision, i.reviewedViewDigest);
        if (i.selectedSpanIds.some(id => !review.passages.some(p => p.ref.spanId === id)) || new Set(i.selectedSpanIds).size !== i.selectedSpanIds.length) throw new KuroError('INVALID_INPUT');
        review.selectedSpanIds = i.selectedSpanIds; review.conditions = i.conditions; review.revision++;
        review.viewDigest = canonicalDigest({ ...review, viewDigest: undefined });
        this.notify('review', review.draftId, review.revision); return review;
      }),
      approveDraft: bind('approveDraft', i => {
        const review = this.review(i.draftId); this.requireRevision(review, i.expectedRevision, i.reviewedViewDigest);
        const responseId = this.next();
        const evidence: EvidenceView = { responseId, requestId: review.requestId, spaceId: review.spaceId, senderKey: DEMO_OWNER.publicKey, question: review.question, passages: review.passages.filter(p => review.selectedSpanIds.includes(p.ref.spanId)), conditions: review.conditions, receivedAtMs: this.now(), expiresAtMs: review.expiresAtMs, bodyDigest: canonicalDigest(review) };
        this.evidence.set(responseId, evidence); this.state.evidenceIds.push(responseId); this.reviews.delete(review.draftId);
        const request = this.state.requests.find(r => r.requestId === review.requestId); if (request) request.state = 'EVIDENCE_READY';
        this.notify('evidence', responseId); return { responseId };
      }),
      getEvidence: bind('getEvidence', i => { const evidence = this.evidence.get(i.responseId); if (!evidence) throw new KuroError('ACCESS_DENIED'); if (evidence.expiresAtMs <= this.now() || this.scenario === 'expired') throw new KuroError('EXPIRED'); return evidence; }),
      requestLocalSummary: bind('requestLocalSummary', i => {
        if (this.scenario === 'model-unavailable') throw new KuroError('MODEL_UNAVAILABLE');
        if (this.scenario === 'capacity') throw new KuroError('CAPACITY_EXCEEDED');
        const evidence = this.evidence.get(i.responseId); if (!evidence || !evidence.conditions.allowLocalSummary) throw new KuroError('ACCESS_DENIED');
        if (evidence.expiresAtMs <= this.now() || this.scenario === 'expired') throw new KuroError('EXPIRED');
        const summaryId = this.next(), jobId = this.next();
        const summary: SummaryView = { summaryId, responseId: i.responseId, state: 'DRAFT', preparationDigest: canonicalDigest(evidence), requiresSemanticReview: true, claims: [{ text: 'Simulated summary: release is provisional until a human signs the review.', quotes: evidence.passages.slice(0, 1) }] };
        this.summaries.set(summaryId, summary); this.state.summaries.push({ summaryId, state: 'DRAFT' }); this.state.jobs.push({ jobId, state: 'COMPLETE' });
        this.notify('summary', summaryId); return { summaryId, jobId };
      }),
      getSummary: bind('getSummary', i => { const summary = this.summaries.get(i.summaryId); if (!summary) throw new KuroError('ACCESS_DENIED'); if (this.scenario === 'expired') throw new KuroError('EXPIRED'); return summary; }),
      cancelJob: bind('cancelJob', i => { const job = this.state.jobs.find(j => j.jobId === i.jobId); if (!job) throw new KuroError('ACCESS_DENIED'); job.state = 'CANCELLED'; this.notify('job', i.jobId); return null; }),
      subscribe: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; },
    };
    this.reset('ready');
  }
  info(): DesktopInfo { return { mode: 'demo', profile: this.profile, ...DEMO_REQUESTER, scenario: this.scenario, peers: [DEMO_OWNER], clockProtection: 'simulated' }; }
  reset(scenario: DesktopScenario): void {
    this.scenario = scenario; this.reviews.clear(); this.evidence.clear(); this.summaries.clear();
    const space = this.newSpace(demoId(1));
    if (scenario === 'offline') space.syncState = 'OFFLINE_VALID';
    if (scenario === 'expired') { space.syncState = 'EXPIRED'; space.remainingValidityMs = 0; }
    this.state = { clockEpochValid: true, spaces: [space], requests: [{ requestId: demoId(2), spaceId: space.spaceId, state: scenario === 'waiting' ? 'QUEUED' : 'REVIEW' }], jobs: scenario === 'waiting' ? [{ jobId: demoId(99), state: 'QUEUED' }] : [], evidenceIds: [demoId(8)], documents: [{ documentId: demoId(3), spaceId: space.spaceId, revision: 0, ingestionState: 'COMPLETE' }], summaries: [] };
    const review = this.newReview(demoId(2), space.spaceId, 'What still needs to happen before the pilot can be released?');
    if (scenario !== 'waiting') this.reviews.set(review.draftId, review);
    this.evidence.set(demoId(8), { responseId: demoId(8), requestId: demoId(9), spaceId: space.spaceId, senderKey: DEMO_OWNER.publicKey, question: 'What is the release condition?', passages: review.passages, conditions: { ...review.conditions, allowLocalSummary: true }, receivedAtMs: this.now(), expiresAtMs: this.now() + 3600000, bodyDigest: canonicalDigest(review) });
    this.notify('space', space.spaceId);
  }
  close(): void { this.closed = true; this.listeners.clear(); }
  private newSpace(spaceId: string): SpaceView { return { spaceId, authorityKey: DEMO_OWNER.publicKey, isOwner: true, policyRevision: 0, policyEpoch: 0, corpusRevision: 1, indexGeneration: 1, syncState: 'CURRENT', lastSyncMs: this.now(), remainingValidityMs: 900000 }; }
  private newReview(requestId: string, spaceId: string, question: string): ReviewView {
    const view: ReviewView = { draftId: this.next(), requestId, spaceId, revision: 0, recipientKey: DEMO_REQUESTER.publicKey, question, passages: [{ ref: { originKey: DEMO_OWNER.publicKey, documentId: demoId(3), versionId: demoId(4), spanId: demoId(5), startByte: 0, endByte: new TextEncoder().encode(DEMO_TEXT).length }, text: DEMO_TEXT }], selectedSpanIds: [demoId(5)], conditions: { v: 1, allowLocalSummary: false, forwarding: 'forbidden', validForSeconds: 3600, notAfterMs: this.now() + 3600000 }, policyEpoch: 0, corpusRevision: 1, indexGeneration: 1, coverage: 'COMPLETE', expiresAtMs: this.now() + 3600000, viewDigest: '0'.repeat(64) };
    view.viewDigest = canonicalDigest(view); return view;
  }
  private next(): string { return demoId(++this.sequence); }
  private space(spaceId: string): SpaceView { const space = this.state.spaces.find(s => s.spaceId === spaceId); if (!space) throw new KuroError('ACCESS_DENIED'); return space; }
  private review(draftId: string): ReviewView { const review = this.reviews.get(draftId); if (!review) throw new KuroError('ACCESS_DENIED'); if (review.expiresAtMs <= this.now() || this.scenario === 'expired') throw new KuroError('EXPIRED'); return review; }
  private requireRevision(review: ReviewView, revision: number, digest: string): void { if (this.scenario === 'stale-review' || review.revision !== revision || review.viewDigest !== digest) throw new KuroError('STALE_REVISION'); }
  private notify(entity: CommittedEvent['entity'], id: string, revision = 0): void { for (const listener of this.listeners) listener({ entity, id, revision }); }
}
