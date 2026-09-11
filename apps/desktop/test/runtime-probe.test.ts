import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiCapabilities, EmbeddingResult, ModelProfile } from '@kuro/contracts';
import { KuroError } from '@kuro/contracts';
import { runRuntimeProbe } from '../src/runtime-probe.js';

const profile: ModelProfile = {
  modelId: 'probe-embedding', modelChecksum: 'a'.repeat(64), dimension: 2, normalization: 'unit', segmentationVersion: 'utf8-v1',
};
const capabilities: AiCapabilities = { provider: 'qvac', embeddingProfiles: [profile], generationProfiles: [], available: true };
const protector = {
  protection: () => 'os-protected' as const,
  encrypt: (text: string) => new Uint8Array(Buffer.from(text)),
  decrypt: (bytes: Uint8Array) => Buffer.from(bytes).toString(),
};

test('runtime probe validates protected concurrent identity storage and closes its AI adapter', async () => {
  let closed = false, embeddings = 0;
  const result = await runRuntimeProbe({
    mode: 'runtime', protector, operationTimeoutMs: 1_000,
    createAi: async () => ({
      profile,
      port: { getCapabilities: async () => capabilities, embedBlocks: async () => { embeddings++; throw new Error('unexpected inference'); } },
      close: async () => { closed = true; },
    }),
  });
  assert.equal(result.storage.concurrentWinner, true);
  assert.equal(result.storage.reopenWinner, true);
  assert.equal(result.ai.operation, 'adapter-load-close');
  assert.equal(result.transport.status, 'not-run');
  assert.equal(result.authorizationGate, 'closed');
  assert.equal(embeddings, 0);
  assert.equal(closed, true);
});

test('inference probe embeds only the identified synthetic block and still closes', async () => {
  let closed = false;
  const result = await runRuntimeProbe({
    mode: 'inference', protector, operationTimeoutMs: 1_000,
    createAi: async () => ({
      profile,
      port: {
        getCapabilities: async () => capabilities,
        embedBlocks: async (input): Promise<EmbeddingResult> => ({ jobId: input.jobId, profile, vectors: [{ id: input.blocks[0]!.id, values: [1, 0] }] }),
      },
      close: async () => { closed = true; },
    }),
  });
  assert.deepEqual(result.ai, { provider: 'qvac', available: true, fallbackDownloads: false, operation: 'cached-embedding', modelId: profile.modelId, dimension: 2, vectors: 1 });
  assert.equal(closed, true);
});

test('runtime probe rejects a plaintext provider before loading AI', async () => {
  let created = false;
  await assert.rejects(runRuntimeProbe({
    mode: 'runtime', operationTimeoutMs: 1_000,
    protector: { ...protector, protection: () => 'basic_text' as const },
    createAi: async () => { created = true; throw new Error('must not load'); },
  }), (error: unknown) => error instanceof KuroError && error.code === 'IDENTITY_UNAVAILABLE');
  assert.equal(created, false);
});
