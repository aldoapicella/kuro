import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSimulatedDesktop, value } from '../../apps/desktop/src/composition/simulated.js';
test('two SQLite cores deliver only human-approved permitted evidence', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'kuro-desktop-'));
 const runtime = await createSimulatedDesktop(directory);
 try {
  const requester = runtime.nodes.get('A')!, owner = runtime.nodes.get('B')!;
  value(await requester.app.submitQuestion({ spaceId: runtime.spaceId, custodianKey: owner.info.publicKey, query: 'What are the KURO pilot release conditions?', ttlSeconds: 3600 }));
  await runtime.pump();
  assert.equal(value(await requester.app.getState({})).evidenceIds.length, 0);
  const review = value(await owner.app.listReviews({ spaceId: runtime.spaceId }))[0]!;
  assert.ok(review);
  assert.ok(!JSON.stringify(review).includes('RESTRICTED-SENTINEL'));
  value(await owner.app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest }));
  await runtime.pump();
  const responseId = value(await requester.app.getState({})).evidenceIds[0]!;
  assert.ok(responseId);
  assert.ok(value(await requester.app.getEvidence({ responseId })).passages.length);
 } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
