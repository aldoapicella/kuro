#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createAiAdapter, QvacClient, QVAC_EMBEDDING_PROFILE, QVAC_GENERATION_PROFILE } from '@kuro/ai';
import { FakeQvacRuntime } from '@kuro/ai/testing';
import { validatePreparation, validateVectors } from '@kuro/contracts';

const real = process.argv.includes('--with-qvac');
const embeddingsOnly = process.argv.includes('--embeddings-only');
const runtime = real ? new QvacClient() : new FakeQvacRuntime({
  completionResponses: [JSON.stringify({ status: 'answer', claims: [{ text: 'Payment is pending approval.', sourceAliases: ['P1'] }] })],
});
const adapter = createAiAdapter(runtime);
const id = character => character.repeat(32);
const text = 'Outstanding observations: payment has not been approved.';
const passage = {
  ref: { originKey: 'a'.repeat(64), documentId: id('1'), versionId: id('2'), spanId: id('3'), startByte: 0, endByte: Buffer.byteLength(text) },
  text,
};
console.log(JSON.stringify({ mode: real ? 'real-qvac' : 'scripted-qvac-backend', node: process.version, platform: process.platform, arch: process.arch }));
try {
  const capabilities = await adapter.port.getCapabilities();
  assert.equal(capabilities.provider, real ? 'qvac' : 'simulated');
  const jobId = id('4');
  const embedded = validateVectors(await adapter.port.embedBlocks({
    jobId, profile: QVAC_EMBEDDING_PROFILE,
    blocks: [{ id: passage.ref.spanId, text, ref: passage.ref }],
  }), jobId, QVAC_EMBEDDING_PROFILE, [passage.ref.spanId]);
  const ranked = await adapter.port.rankAllowed({ jobId: id('5'), profile: embedded.profile, query: embedded.vectors[0], candidates: embedded.vectors, limit: 1 });
  assert.equal(ranked.ranked[0]?.id, passage.ref.spanId);
  console.log(JSON.stringify({ embedding: 'passed', profile: embedded.profile, vectors: embedded.vectors.length, selfSimilarity: ranked.ranked[0].score }));
  if (!embeddingsOnly) {
    const input = { jobId: id('6'), preparationId: id('7'), deliveryId: id('8'), profile: QVAC_GENERATION_PROFILE, question: 'What is the payment status?', passages: [passage] };
    const preparation = validatePreparation(await adapter.port.prepareSummary(input), input);
    const result = await adapter.port.runPreparedSummary(preparation);
    assert.equal(result.preparationDigest, preparation.digest);
    assert.equal(result.completion, 'complete');
    assert.ok(result.claims.every(claim => claim.sourceAliases.every(alias => preparation.sources.some(source => source.alias === alias))));
    console.log(JSON.stringify({ summary: 'passed', profile: preparation.profile, contextTokens: preparation.contextTokens, tokenAccounting: preparation.tokenAccounting, status: result.status, claims: result.claims, requiresSemanticReview: true }));
  }
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', code: error?.code ?? error?.name ?? 'UNKNOWN' }));
  process.exitCode = 1;
} finally {
  await adapter.close();
  console.log('AI runtime closed.');
}
