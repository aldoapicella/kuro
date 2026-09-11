import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSimulatedDesktop, value } from '../../apps/desktop/src/composition/simulated.js';
import { DEMO_OWNER, DEMO_REQUESTER } from '../../apps/desktop/src/fake-app.js';
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

test('simulated desktop reports the supplied AI provider capability', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'kuro-desktop-provider-'));
 const suppliedDirectory = await mkdtemp(join(tmpdir(), 'kuro-desktop-provider-source-'));
 const suppliedRuntime = await createSimulatedDesktop(suppliedDirectory);
 const suppliedAi = suppliedRuntime.nodes.get('A')!.ai;
 const runtime = await createSimulatedDesktop(directory, { createAi: () => suppliedAi });
 try {
  assert.equal(runtime.nodes.get('A')!.info.aiProvider, 'simulated');
  assert.equal(runtime.nodes.get('B')!.info.aiProvider, 'simulated');
 } finally { await runtime.close(); await suppliedRuntime.close(); await rm(directory, { recursive: true, force: true }); await rm(suppliedDirectory, { recursive: true, force: true }); }
});

test('simulated pump serializes shared AI work across both cores', { timeout: 5000 }, async () => {
 const directory = await mkdtemp(join(tmpdir(), 'kuro-desktop-pump-'));
 const suppliedDirectory = await mkdtemp(join(tmpdir(), 'kuro-desktop-pump-source-'));
 const suppliedRuntime = await createSimulatedDesktop(suppliedDirectory);
 const delegate = suppliedRuntime.nodes.get('A')!.ai;
 let active = 0, peak = 0, hold = false, release!: () => void;
 let firstStarted!: () => void;
 const started = new Promise<void>(resolve => { firstStarted = resolve; });
 const gate = new Promise<void>(resolve => { release = resolve; });
 const ai = {
  getCapabilities: () => delegate.getCapabilities(),
  embedBlocks: async (input: Parameters<typeof delegate.embedBlocks>[0]) => {
   active += 1; peak = Math.max(peak, active); if (hold && active === 1) firstStarted();
   try { if (hold) await gate; return await delegate.embedBlocks(input); }
   finally { active -= 1; }
  },
  rankAllowed: (input: Parameters<typeof delegate.rankAllowed>[0]) => delegate.rankAllowed(input),
  prepareSummary: (input: Parameters<typeof delegate.prepareSummary>[0]) => delegate.prepareSummary(input),
  runPreparedSummary: (input: Parameters<typeof delegate.runPreparedSummary>[0]) => delegate.runPreparedSummary(input),
  cancel: (input: Parameters<typeof delegate.cancel>[0]) => delegate.cancel(input),
 };
 const runtime = await createSimulatedDesktop(directory, { createAi: () => ai });
 let closed = false;
 try {
  const canonicalDirectory = await realpath(directory);
  const owner = runtime.nodes.get('B')!, requester = runtime.nodes.get('A')!;
  const imports = [
   [owner, 'owner', DEMO_OWNER.memberId],
   [requester, 'requester', DEMO_REQUESTER.memberId],
  ] as const;
  for (const [node, name, memberId] of imports) {
   const path = join(canonicalDirectory, `${name}-pump.txt`);
   await writeFile(path, name, { mode: 0o600 });
   value(await node.app.importText({ spaceId: runtime.spaceId, selectionId: node.files.register(path), replaceDocumentId: null, expectedRevision: null, rules: [{ memberId, actions: ['read', 'share'], validUntilMs: null }] }));
  }
  hold = true;
  const pumping = runtime.pump();
  await started;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(peak, 1);
  let closeCalls = 0;
  const closing = runtime.close(async () => {
   closeCalls += 1;
   await Promise.all([...runtime.nodes.values()].map(node => node.core.stop()));
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closeCalls, 0);
  release();
  await Promise.all([pumping, closing]);
  closed = true;
  assert.equal(peak, 1);
  assert.equal(closeCalls, 1);
 } finally {
  release();
  if (!closed) await runtime.close();
  await suppliedRuntime.close();
  await rm(directory, { recursive: true, force: true });
  await rm(suppliedDirectory, { recursive: true, force: true });
 }
});
