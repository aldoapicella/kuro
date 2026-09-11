import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWire } from '@kuro/contracts';
import { makeWorld, ok } from '../../../packages/core/test/world.js';
import { LifecycleClock } from '../src/lifecycle-clock.js';
import { DesktopLifecycle } from '../src/lifecycle.js';

function guard(node: Awaited<ReturnType<typeof makeWorld>>['owner']) {
  let epoch = 0n;
  const clock = new LifecycleClock(() => ({ sleepEpoch: epoch, wallMs: node.clock.wall, monotonicMs: node.clock.mono }));
  node.clock.wallNowMs = () => clock.wallNowMs(); node.clock.monotonicNowMs = () => clock.monotonicNowMs();
  const lifecycle = new DesktopLifecycle([node.core], undefined, clock);
  return { lifecycle, wake: () => { epoch++; }, clock };
}
async function delivered(w: Awaited<ReturnType<typeof makeWorld>>) {
  await w.importDoc('Outstanding observations: authorized synthetic evidence.');
  const initial = await w.review();
  const review = ok(await w.owner.core.app.reviseDraft({ draftId: initial.draftId, expectedRevision: initial.revision, reviewedViewDigest: initial.viewDigest, selectedSpanIds: initial.selectedSpanIds, conditions: { ...initial.conditions, allowLocalSummary: true } }));
  const result = ok(await w.owner.core.app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest }));
  await w.pump(); return result.responseId;
}

test('a participant cannot read on first wake callback or install a pre-sleep authority response', async () => {
  const w = await makeWorld();
  try {
    const responseId = await delivered(w), g = guard(w.requester);
    w.advance(6000); ok(await w.requester.core.app.refreshSpace({ spaceId: w.spaceId }));
    await w.requester.core.tick(); w.network.flush(); await w.owner.core.settled();
    // The authority response is queued in the network when the device sleeps.
    const before = w.owner.transport.sent.filter(frame => decodeWire(frame.bytes).type === 'SPACE_STATE_RESPONSE').at(-1)!;
    assert.ok(before); g.wake();
    const denied = await w.requester.core.app.getEvidence({ responseId });
    assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'CLOCK_UNCERTAIN');
    await g.lifecycle.resume(); // Durable stale install and fresh Clock, BEFORE old packet delivery.
    w.network.flush(); await w.requester.core.settled();
    assert.equal(w.inspect('requester', 'SELECT cache_stale FROM authority_spaces')[0]!.cache_stale, 1);
    assert.equal((await w.requester.core.app.getEvidence({ responseId })).ok, false);
    await w.pump();
    assert.equal(ok(await w.requester.core.app.getState({})).spaces[0]!.syncState, 'CURRENT');
    assert.ok(ok(await w.requester.core.app.getEvidence({ responseId })).passages.length);
    const after = w.owner.transport.sent.filter(frame => decodeWire(frame.bytes).type === 'SPACE_STATE_RESPONSE').at(-1)!;
    assert.notDeepEqual(after.bytes, before.bytes, 'resumed authority must answer a new correlated request');
  } finally { await w.close(); }
});

test('recovery recommits cancellation after an interrupted writer rolls it back', async () => {
  const w = await makeWorld();
  try {
    await w.importDoc('Outstanding observations held for explicit review.'); const review = await w.review();
    const g = guard(w.owner);
    // Simulate sleep at a writer checkpoint, then rollback the interrupted writer.
    w.owner.faults.point = 'after_approval_insert';
    w.owner.faults.onHit = () => { g.wake(); try { g.clock.check(); } catch {} };
    const approval = await w.owner.core.app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest });
    assert.equal(approval.ok, false);
    w.owner.faults.point = ''; delete w.owner.faults.onHit;
    await g.lifecycle.resume();
    assert.equal(w.inspect('owner', 'SELECT state FROM reviews')[0]!.state, 'CANCELLED');
    assert.equal(w.inspect('owner', 'SELECT count(*) n FROM approvals')[0]!.n, 0);
    assert.equal((await w.owner.core.app.getReview({ draftId: review.draftId })).ok, false);
    await w.pump();
    assert.equal(w.owner.transport.sent.some(frame => decodeWire(frame.bytes).type === 'APPROVED_RESPONSE'), false);
  } finally { await w.close(); }
});

test('an approved but unsent delivery is cancelled by the first post-wake dispatch check', async () => {
  const w = await makeWorld();
  try {
    await w.importDoc('Outstanding observations held for delivery.'); const review = await w.review();
    const g = guard(w.owner);
    ok(await w.owner.core.app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest }));
    g.wake(); await assert.rejects(w.owner.core.tick());
    await g.lifecycle.resume(); w.advance(6000); await w.pump();
    assert.equal(w.inspect('owner', 'SELECT state FROM outbox')[0]!.state, 'CANCELLED');
    assert.equal(w.owner.transport.sent.some(frame => decodeWire(frame.bytes).type === 'APPROVED_RESPONSE'), false);
  } finally { await w.close(); }
});

test('a valid late AI result is discarded when wake precedes the power event', async () => {
  const w = await makeWorld();
  try {
    const responseId = await delivered(w), g = guard(w.requester);
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(done => { release = done; });
    const entered = new Promise<void>(done => { started = done; });
    const original = w.requester.ai.runPreparedSummary.bind(w.requester.ai);
    w.requester.ai.runPreparedSummary = async input => {
      const result = await original(input); started(); await waiting; return result;
    };
    ok(await w.requester.core.app.requestLocalSummary({ responseId }));
    await w.requester.core.tick(); await entered;
    g.wake(); release(); await w.requester.core.settled();
    assert.equal(w.inspect('requester', 'SELECT state FROM summaries')[0]!.state, 'CANCELLED');
    await g.lifecycle.resume(); w.advance(6000); await w.pump();
    assert.equal(w.inspect('requester', 'SELECT state FROM summaries')[0]!.state, 'CANCELLED');
    assert.equal((await w.requester.core.app.getEvidence({ responseId })).ok, true);
  } finally { await w.close(); }
});
