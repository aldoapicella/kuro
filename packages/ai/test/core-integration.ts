import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePreparation, type AiPort, type Capability, type PreparedSummary, type Result } from '@kuro/contracts';
import { openCore } from '@kuro/core';
import { FakeClock, FakeIds, FakePairing, FakeSession, MemorySelectedFiles } from '@kuro/core/testing';
import { MemoryNetwork, MemoryTransport } from '@kuro/transport';
import { createAiAdapter, type CompletionRequest } from '@kuro/ai';
import { FakeQvacRuntime } from '@kuro/ai/testing';

const ALL: Capability[] = ['search', 'read', 'share', 'receive', 'manage'];
function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

// Real adapter and SQLite cores; only the numerical backend and transport are scripted.
test('public ports preserve authorization, human approval, durable delivery and explicit summary', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kuro-ai-core-'));
  const network = new MemoryNetwork();
  let releaseCompletion!: () => void;
  const completionGate = new Promise<void>(resolve => { releaseCompletion = resolve; });
  async function node(label: string, key: string, otherKey: string, memberId: string) {
    const runtime = new FakeQvacRuntime({
      completionGate,
      completionResponses: [JSON.stringify({ status: 'answer', claims: [{ text: 'Payment is pending approval.', sourceAliases: ['P1'] }] })],
    });
    const completionRequests: CompletionRequest[] = [];
    const runCompletion = runtime.runCompletion.bind(runtime);
    runtime.runCompletion = async request => {
      completionRequests.push(structuredClone(request));
      return runCompletion(request);
    };
    const adapter = createAiAdapter(runtime);
    const rankInputs: Parameters<AiPort['rankAllowed']>[0][] = [];
    const rankAllowed = adapter.port.rankAllowed.bind(adapter.port);
    adapter.port.rankAllowed = async input => {
      rankInputs.push(structuredClone(input));
      return rankAllowed(input);
    };
    const ids = new FakeIds(label);
    const clock = new FakeClock();
    const pairing = new FakePairing(ids);
    const files = new MemorySelectedFiles(ids);
    const databasePath = join(directory, `${label}.sqlite`);
    const core = await openCore({
      databasePath, ai: adapter.port, clock, ids, pairing, selectedFiles: files, clockInitiallyTrusted: true,
      sessions: new FakeSession({ memberId, deviceKey: key, validUntilMs: clock.wall + 100_000_000 }),
      transport: new MemoryTransport({ network, publicKey: key, pairedPeers: [otherKey] }),
    });
    function inspect(sql: string) {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try { return db.prepare(sql).all(); } finally { db.close(); }
    }
    return { core, runtime, adapter, pairing, files, memberId, key, rankInputs, completionRequests, inspect };
  }
  const owner = await node('owner', 'a'.repeat(64), 'b'.repeat(64), '1'.repeat(32));
  const requester = await node('requester', 'b'.repeat(64), 'a'.repeat(64), '2'.repeat(32));
  async function pump(rounds = 8) {
    for (let round = 0; round < rounds; round++) {
      await owner.core.tick(); await requester.core.tick(); network.flush();
      await owner.core.settled(); await requester.core.settled();
    }
  }
  try {
    const initial = ok(await owner.core.app.createSpace({ capabilities: ALL, localActions: ALL }));
    const spaceId = initial.spaceId;
    const spaceAlias = 'c'.repeat(32);
    const selectionId = owner.pairing.verify({ kind: 'member', spaceId, memberId: requester.memberId, peerKey: requester.key, spaceAlias });
    let ownerView = ok(await owner.core.app.enrollMember({ spaceId, selectionId, capabilities: ALL, validUntilMs: null, expectedRevision: initial.policyRevision }));
    ownerView = ok(await owner.core.app.setRelationship({ spaceId, memberId: owner.memberId, otherMemberId: requester.memberId, allowed: true, validUntilMs: null, expectedRevision: ownerView.policyRevision }));
    const authority = requester.pairing.verify({ kind: 'authority', spaceId, authorityKey: owner.key, spaceAlias });
    ok(await requester.core.app.pairSpace({ selectionId: authority, localActions: ALL }));
    ok(await requester.core.app.refreshSpace({ spaceId })); await pump();
    const requesterView = ok(await requester.core.app.getState({})).spaces[0]!;
    assert.equal(requesterView.syncState, 'CURRENT');
    ok(await owner.core.app.setLocalPolicy({ spaceId, memberId: requester.memberId, admitted: true, actions: ALL, validUntilMs: null, expectedRevision: ownerView.policyEpoch }));
    ok(await requester.core.app.setLocalPolicy({ spaceId, memberId: owner.memberId, admitted: true, actions: ALL, validUntilMs: null, expectedRevision: requesterView.policyEpoch }));
    const peer = requester.pairing.verify({ kind: 'peer', spaceId, peerKey: owner.key, spaceAlias });
    ok(await requester.core.app.pairPeer({ selectionId: peer }));
    const ownerRule = { memberId: owner.memberId, actions: ALL, validUntilMs: null };
    const sharedRules = [ownerRule, { memberId: requester.memberId, actions: ['receive'] as Capability[], validUntilMs: null }];
    async function importText(text: string, targetSpace = spaceId, restricted = false) {
      const imported = ok(await owner.core.app.importText({
        spaceId: targetSpace, selectionId: owner.files.add(text), replaceDocumentId: null, expectedRevision: null,
        rules: restricted ? [ownerRule] : sharedRules,
      }));
      await pump();
      assert.equal(ok(await owner.core.app.getState({})).documents.find(d => d.documentId === imported.documentId)?.ingestionState, 'COMPLETE');
      return imported;
    }
    const text = 'Outstanding observations: payment has not been approved.';
    const permitted = await importText(text);
    await importText('Outstanding observations: RESTRICTED_SENTINEL.', spaceId, true);
    const otherSpace = ok(await owner.core.app.createSpace({ capabilities: ALL, localActions: ALL }));
    await importText('Outstanding observations: OTHER_SPACE_SENTINEL.', otherSpace.spaceId, true);
    ok(await requester.core.app.submitQuestion({ spaceId, custodianKey: owner.key, query: 'Outstanding observations and payment status?', ttlSeconds: 3600 }));
    await pump();
    let review = ok(await owner.core.app.listReviews({ spaceId }))[0]!;
    assert.deepEqual(review.passages.map(p => p.text), [text]);
    assert.equal((owner.rankInputs).length, 1);
    assert.deepEqual(owner.rankInputs[0]!.candidates.map(c => c.id), review.passages.map(p => p.ref.spanId));
    assert.equal(review.passages[0]!.ref.documentId, permitted.documentId);
    assert.deepEqual(ok(await requester.core.app.getState({})).evidenceIds, []);
    assert.equal((owner.inspect('SELECT * FROM approvals')).length, 0);
    assert.equal((requester.completionRequests).length, 0);

    review = ok(await owner.core.app.reviseDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest, selectedSpanIds: review.selectedSpanIds, conditions: { ...review.conditions, allowLocalSummary: true } }));
    const { responseId } = ok(await owner.core.app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest }));
    await pump();
    const evidence = ok(await requester.core.app.getEvidence({ responseId }));
    assert.deepEqual(evidence.passages, review.passages);
    assert.equal(owner.inspect('SELECT state FROM outbox WHERE response_id IS NOT NULL')[0]?.state, 'ACKED');
    assert.equal((requester.completionRequests).length, 0);
    assert.equal((requester.inspect('SELECT * FROM summaries')).length, 0);

    const { summaryId } = ok(await requester.core.app.requestLocalSummary({ responseId }));
    await requester.core.tick();
    // Leave the provider unresolved while inspecting the independently committed manifest.
    for (let turn = 0; turn < 50 && requester.completionRequests.length === 0; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal((requester.completionRequests).length, 1);
    const row = requester.inspect('SELECT * FROM summaries')[0]!;
    assert.equal(row.result_json, null);
    const preparation = JSON.parse(String(row.preparation_json)) as PreparedSummary;
    validatePreparation(preparation, { jobId: preparation.jobId, preparationId: preparation.preparationId, deliveryId: responseId, profile: preparation.profile, question: evidence.question, passages: evidence.passages });
    assert.equal(requester.completionRequests[0]!.context, preparation.context);
    assert.equal(requester.completionRequests[0]!.outputTokens, preparation.reservedOutputTokens);
    assert.equal(preparation.context.includes('SENTINEL'), false);
    releaseCompletion(); await requester.core.settled();
    const summary = ok(await requester.core.app.getSummary({ summaryId }));
    assert.equal(summary.state, 'DRAFT');
    assert.equal(summary.requiresSemanticReview, true);
    assert.equal(summary.preparationDigest, preparation.digest);
    assert.deepEqual(summary.claims[0]!.quotes, [evidence.passages[0]]);
  } finally {
    releaseCompletion();
    await owner.core.stop(); await requester.core.stop();
    await owner.adapter.close(); await requester.adapter.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
