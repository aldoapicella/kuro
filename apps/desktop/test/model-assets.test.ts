import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelAssets } from '../src/model-assets.js';

const payload = Buffer.from('Synthetic model bytes for download behavior; not an inference model.');
const asset = { kind: 'embedding' as const, name: 'SYNTHETIC_DOWNLOAD_TEST', bytes: payload.length,
  sha256: createHash('sha256').update(payload).digest('hex'), url: 'https://models.example.test/fixture' };
const sufficientDisk = async () => 1024 ** 3;

test('models download only on explicit action, verify exact bytes, and recheck a reopened cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuro-model-test-'));
  let downloads = 0;
  const options = { assets: [asset], freeDiskBytes: sufficientDisk, fetch: async () => { downloads++; return new Response(payload); } };
  let models = new ModelAssets(directory, options);
  try {
    await models.inspect();
    assert.equal(downloads, 0);
    assert.equal(models.snapshot()[0]!.state, 'missing');
    await assert.rejects(models.path('embedding'), /MODEL_UNAVAILABLE/);
    await models.prepare('embedding'); await models.settled();
    assert.equal(models.snapshot()[0]!.state, 'ready');
    assert.deepEqual(await readFile(await models.path('embedding')), payload);
    assert.equal(downloads, 1);
    await models.close();
    models = new ModelAssets(directory, options);
    await models.inspect();
    assert.equal(models.snapshot()[0]!.state, 'ready');
    assert.equal(downloads, 1);
    await models.close();
    await writeFile(join(directory, 'embedding.gguf'), Buffer.alloc(payload.length, 0));
    models = new ModelAssets(directory, options);
    await models.inspect();
    assert.equal(models.snapshot()[0]!.state, 'missing');
    await assert.rejects(models.path('embedding'), /MODEL_UNAVAILABLE/);
    assert.equal(downloads, 1, 'corrupt cache must not trigger an implicit download');
  } finally { await models.close(); await rm(directory, { recursive: true, force: true }); }
});

test('insufficient disk and invalid model bytes fail explicitly without publishing a usable path', async t => {
  for (const scenario of ['disk', 'checksum', 'oversized', 'downgrade'] as const) await t.test(scenario, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kuro-model-failure-'));
    let requests = 0;
    const models = new ModelAssets(directory, { assets: [asset],
      freeDiskBytes: scenario === 'disk' ? async () => 0 : sufficientDisk,
      fetch: async () => {
        requests++;
        return scenario === 'downgrade' ? new Response(null, { status: 302, headers: { location: 'http://example.test/fixture' } }) :
          new Response(scenario === 'oversized' ? Buffer.alloc(payload.length + 1) : Buffer.alloc(payload.length));
      },
    });
    try {
      await models.prepare('embedding'); await models.settled();
      const state = models.snapshot()[0]!;
      assert.equal(state.state, 'failed');
      assert.equal(state.error, scenario === 'disk' ? 'INSUFFICIENT_DISK' : scenario === 'downgrade' ? 'NETWORK_FAILURE' : 'CHECKSUM_MISMATCH');
      assert.equal(requests, scenario === 'disk' ? 0 : 1);
      await assert.rejects(models.path('embedding'), /MODEL_UNAVAILABLE/);
      assert.deepEqual(await readdir(directory), []);
    } finally { await models.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('cancellation stops an active transfer, cleans partial bytes and permits explicit retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuro-model-cancel-'));
  let retry = false;
  let started!: () => void;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  const models = new ModelAssets(directory, { assets: [asset], freeDiskBytes: sufficientDisk,
    fetch: async (_url, options) => {
      if (retry) return new Response(payload);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload.subarray(0, 4));
          options?.signal?.addEventListener('abort', () => { controller.error(new Error('aborted test download')); }, { once: true });
          started();
        },
      }));
    },
  });
  try {
    await models.prepare('embedding'); await inFlight;
    await assert.rejects(models.prepare('embedding'), /CAPACITY_EXCEEDED/);
    await models.cancel('embedding');
    assert.equal(models.snapshot()[0]!.state, 'cancelled');
    assert.deepEqual(await readdir(directory), []);
    retry = true;
    await models.prepare('embedding'); await models.settled();
    assert.equal(models.snapshot()[0]!.state, 'ready');
    await models.close();
    await assert.rejects(models.prepare('embedding'), /MODEL_UNAVAILABLE/);
  } finally { await models.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SDK load rejects a replaced verified model without downloading or retaining readiness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kuro-model-replacement-'));
  let downloads = 0;
  const models = new ModelAssets(directory, { assets: [asset], freeDiskBytes: sufficientDisk,
    fetch: async () => { downloads++; return new Response(payload); } });
  try {
    await models.prepare('embedding'); await models.settled();
    assert.equal(await models.path('embedding'), join(directory, 'embedding.gguf'));
    await writeFile(join(directory, 'embedding.gguf'), Buffer.alloc(payload.length, 0));
    await assert.rejects(models.path('embedding'), /MODEL_UNAVAILABLE/);
    assert.equal(models.snapshot()[0]!.state, 'missing');
    assert.equal(downloads, 1);
    await models.prepare('embedding'); await models.settled();
    assert.equal(downloads, 2, 'replacement requires an explicit retry');
    await models.close();
    await assert.rejects(models.path('embedding'), /MODEL_UNAVAILABLE/);
  } finally { await models.close(); await rm(directory, { recursive: true, force: true }); }
});
