import test from 'node:test';
import assert from 'node:assert/strict';
import { AppCommands, canonicalDigest, preparationDigest, summaryContext, validatePreparation, validateVectors, SUMMARY_PROMPT_VERSION, SUMMARY_SCHEMA_VERSION } from '../src/index.js';
import type { ModelProfile, SummaryPreparationInput, PreparedSummary } from '../src/index.js';

const id = 'a'.repeat(32);
const profile: ModelProfile = { modelId: 'synthetic', modelChecksum: 'b'.repeat(64), dimension: 2, normalization: 'unit', segmentationVersion: 'utf8-v1' };
test('identified embedding results reject incomplete, nonfinite, zero, incompatible and unnormalized vectors', () => {
  const valid = { jobId: id, profile, vectors: [{ id, values: [1, 0] }] };
  assert.deepEqual(validateVectors(valid, id, profile, [id]), valid);
  for (const values of [[0, 0], [Infinity, 0], [1], [2, 0]]) assert.throws(() => validateVectors({ ...valid, vectors: [{ id, values }] }, id, profile, [id]));
  assert.throws(() => validateVectors(valid, id, { ...profile, modelId: 'different' }, [id]));
  assert.throws(() => validateVectors(valid, id, profile, [id, 'c'.repeat(32)]));
});
test('local commands reject renderer identity, arbitrary paths and replacement approval content', () => {
  assert.equal(AppCommands.approveDraft.safeParse({ draftId: id, expectedRevision: 1, reviewedViewDigest: 'b'.repeat(64), passages: [] }).success, false);
  assert.equal(AppCommands.importText.safeParse({ path: '/private/source.txt', spaceId: id }).success, false);
  assert.equal(AppCommands.getState.safeParse({ memberId: id }).success, false);
});
test('summary preparation accounts for omitted and uncited inputs and verifies exact envelope', () => {
  const passage = { ref: { originKey: 'b'.repeat(64), documentId: id, versionId: id, spanId: id, startByte: 0, endByte: 7 }, text: 'Pending' };
  const input: SummaryPreparationInput = { jobId: id, preparationId: id, deliveryId: id, profile: { modelId: 'synthetic', modelChecksum: 'b'.repeat(64), tokenizerId: 'byte-bound', contextTokens: 4096, outputTokens: 512 }, question: 'Status?', passages: [passage] };
  const sources = [{ alias: 'P1', passage }];
  const context = summaryContext(input.question, sources);
  const body: Omit<PreparedSummary, 'digest'> = { jobId: id, preparationId: id, deliveryId: id, profile: input.profile, promptVersion: SUMMARY_PROMPT_VERSION, schemaVersion: SUMMARY_SCHEMA_VERSION, question: input.question, questionDigest: canonicalDigest(input.question), sources, omittedReferences: [], context, contextTokens: new TextEncoder().encode(context).length, reservedOutputTokens: 512, tokenAccounting: 'validated-byte-upper-bound' };
  const valid = { ...body, digest: preparationDigest(body) };
  assert.deepEqual(validatePreparation(valid, input), valid);
  const changed = { ...body, context: body.context + 'hidden source' };
  assert.throws(() => validatePreparation({ ...changed, digest: preparationDigest(changed) }, input));
  assert.throws(() => validatePreparation(valid, { ...input, passages: [...input.passages, { ...passage, ref: { ...passage.ref, spanId: 'c'.repeat(32) } }] }));
});
