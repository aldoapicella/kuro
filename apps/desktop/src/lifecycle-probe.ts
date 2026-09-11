import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createSimulatedDesktop, value } from './composition/simulated.js';
import { LifecycleClock } from './lifecycle-clock.js';
import { DesktopLifecycle } from './lifecycle.js';
import { loadNativeClock } from './native-clock.js';

/** Explicit synthetic workflow; actual packaged native Clock and SQLite.
 * This probe never describes injected lifecycle events as physical sleep. */
export async function runLifecycleProbe(powerEvents?: () => number) {
  const native = loadNativeClock();
  const clock = new LifecycleClock(native);
  const start = performance.now();
  for (let read = 0; read < 10_000; read++) clock.check();
  const sampleTimeMs = performance.now() - start;
  const directory = await mkdtemp(join(tmpdir(), 'kuro-lifecycle-probe-'));
  let runtime: Awaited<ReturnType<typeof createSimulatedDesktop>> | undefined;
  try {
    runtime = await createSimulatedDesktop(directory, { clock });
    const owner = runtime.nodes.get('B')!, requester = runtime.nodes.get('A')!;
    const lifecycle = new DesktopLifecycle([owner.core, requester.core], undefined, clock);
    value(await requester.app.submitQuestion({ spaceId: runtime.spaceId, custodianKey: owner.info.publicKey, query: 'What are the KURO pilot release conditions?', ttlSeconds: 3600 }));
    await runtime.pump();
    const review = value(await owner.app.listReviews({ spaceId: runtime.spaceId }))[0]!;
    const approved = value(await owner.app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest }));
    await runtime.pump();
    const expected = value(await requester.app.getEvidence({ responseId: approved.responseId }));
    const pendingReply = requester.app.getEvidence({ responseId: approved.responseId });
    if (powerEvents) {
      const before = native();
      console.log(JSON.stringify({ probe: 'lifecycle-sleep', status: 'ready-for-sleep', maximumWaitSeconds: 90 }));
      // Deliberately stall JavaScript event dispatch while the OS can sleep/wake.
      // A queued powerMonitor callback cannot be the mechanism that closes us.
      const wait = new Int32Array(new SharedArrayBuffer(4));
      let detected = false;
      while (native().monotonicMs - before.monotonicMs < 90_000) {
        try { clock.check(); } catch { detected = true; break; }
        Atomics.wait(wait, 0, 0, 5);
      }
      assert.equal(detected, true, 'No physical sleep was detected within 90 seconds');
      assert.notEqual(native().sleepEpoch, before.sleepEpoch, 'Clock errors alone do not prove physical sleep');
      assert.equal(powerEvents(), 0, 'Native closing must precede queued JavaScript power events');
    } else lifecycle.suspend();
    assert.equal((await pendingReply).ok, false);
    assert.equal((await requester.app.getEvidence({ responseId: approved.responseId })).ok, false);
    await lifecycle.resume();
    const resumed = value(await requester.app.getState({}));
    assert.equal(resumed.clockEpochValid, true);
    assert.equal(resumed.spaces[0]!.syncState, 'STALE');
    assert.equal((await requester.app.getEvidence({ responseId: approved.responseId })).ok, false);
    // Honor the real clock and the unchanged authority request rate limit.
    await delay(6100); await runtime.pump();
    assert.equal(value(await requester.app.getState({})).spaces[0]!.syncState, 'CURRENT');
    assert.deepEqual(value(await requester.app.getEvidence({ responseId: approved.responseId })), expected);
    return { status: 'passed', probe: powerEvents ? 'lifecycle-sleep' : 'lifecycle', electron: process.versions.electron, node: process.versions.node,
      nativeClock: true, nativeSamples: 10_000, sampleTimeMs, cores: 2, sqlite: true,
      ai: 'simulated', transport: 'simulated', powerEvents: powerEvents ? 'actual-native-before-JavaScript' : 'injected', physicalSleep: Boolean(powerEvents),
      pendingReplyDiscarded: true, freshAuthorityRequired: true, authorizedEvidenceRecovered: true, authorizationGate: 'native' };
  } finally {
    // Shutdown needs no clock trust; it cannot restore or disclose protected state.
    await runtime?.close(); await rm(directory, { recursive: true, force: true });
  }
}
