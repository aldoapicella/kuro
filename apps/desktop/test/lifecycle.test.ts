import test from 'node:test';
import assert from 'node:assert/strict';
import { KuroError, success } from '@kuro/contracts';
import type { CoreLifecyclePort } from '@kuro/contracts';
import { LifecycleClock } from '../src/lifecycle-clock.js';
import { DesktopLifecycle } from '../src/lifecycle.js';
import { RendererBarrier } from '../src/renderer-barrier.js';
import { routeCall } from '../src/ipc-router.js';

const uncertain = (error: unknown) => error instanceof KuroError && error.code === 'CLOCK_UNCERTAIN';
const stub = (overrides: Partial<CoreLifecyclePort> = {}): CoreLifecyclePort => ({
  start: async () => {}, stop: async () => {}, suspend: () => {}, resume: async () => {}, tick: async () => {}, ...overrides,
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function clockFixture() {
  const sample = { sleepEpoch: 12n, wallMs: 1_800_000_000_000, monotonicMs: 1000 };
  let failed = false;
  const clock = new LifecycleClock(() => { if (failed) throw new Error('native read failed'); return { ...sample }; });
  return { sample, clock, fail: () => { failed = true; }, repair: () => { failed = false; } };
}

test('native epoch closes before a delayed power callback, then recovery commits before opening', async () => {
  const f = clockFixture(), order: string[] = [];
  const lifecycle = new DesktopLifecycle([stub({ suspend: () => { order.push('suspend'); }, resume: async trusted => { order.push(`resume:${trusted}`); } })], undefined, f.clock, () => { order.push('clear'); });
  const before = lifecycle.checkpoint();
  f.sample.sleepEpoch++; // Short sleep: no clock-difference tolerance may miss it.
  assert.throws(() => f.clock.wallNowMs(), uncertain);
  assert.deepEqual(order, ['clear', 'suspend']);
  assert.throws(() => lifecycle.checkpoint(), uncertain);
  await lifecycle.tick(); // Recovery works even before Electron's resume callback.
  assert.deepEqual(order, ['clear', 'suspend', 'suspend', 'resume:true']);
  assert.notEqual(lifecycle.checkpoint(), before);
  lifecycle.suspend(); // A late/duplicate suspend event closes conservatively.
  await lifecycle.resume();
  lifecycle.checkpoint();
});

test('both Clock getters reject failed samples and rebasing cannot bless rollback', () => {
  const f = clockFixture(); let closures = 0; f.clock.onUncertain = () => { closures++; f.clock.check(); };
  f.fail(); assert.throws(() => f.clock.monotonicNowMs(), uncertain);
  assert.equal(closures, 1); f.repair();
  assert.throws(() => f.clock.wallNowMs(), uncertain, 'good samples do not reopen a latched gate');
  f.sample.wallMs--; assert.throws(() => f.clock.rebase(), uncertain);
  f.sample.wallMs++; f.clock.rebase(); f.clock.check();
  f.sample.monotonicMs--; assert.throws(() => f.clock.wallNowMs(), uncertain);
  assert.throws(() => f.clock.rebase(), uncertain);
});

test('failed durable suspend, lock, and a second sleep during resume cannot reopen the gate', async () => {
  const f = clockFixture(); let fail = true, resumed = 0;
  const waiting = deferred<void>();
  const lifecycle = new DesktopLifecycle([stub({
    suspend: () => { if (fail) throw new Error('writer failed'); },
    resume: async () => { resumed++; if (resumed === 1) await waiting.promise; },
  })], undefined, f.clock);
  assert.throws(() => lifecycle.suspend(), /writer failed/);
  await assert.rejects(lifecycle.resume(), /writer failed/); assert.equal(resumed, 0);
  fail = false; lifecycle.lock(); await lifecycle.resume(); assert.equal(resumed, 0);
  const recovery = lifecycle.unlock(); await new Promise<void>(done => setImmediate(done));
  f.sample.sleepEpoch++; waiting.resolve();
  await assert.rejects(recovery, uncertain); assert.throws(() => lifecycle.checkpoint(), uncertain);
  await lifecycle.resume(); lifecycle.checkpoint();
});

test('a host without a qualified native clock never resumes core trust', async () => {
  const trusted: boolean[] = [];
  const lifecycle = new DesktopLifecycle([stub({ resume: async value => { trusted.push(value); } })]);
  lifecycle.suspend(); await lifecycle.resume(); assert.deepEqual(trusted, [false]);
});

test('IPC results computed before wake are discarded before delivery', async () => {
  const f = clockFixture(), pending = deferred<ReturnType<typeof success<null>>>();
  const lifecycle = new DesktopLifecycle([stub()], undefined, f.clock);
  const binding = { senderId: 1, url: 'file:///trusted', app: { cancelJob: () => pending.promise } as never, host: {} as never, checkpoint: () => lifecycle.checkpoint() };
  const reply = routeCall(binding, { id: 1, url: binding.url, isMainFrame: true }, 'app', 'cancelJob', { jobId: '1'.repeat(32) });
  f.sample.sleepEpoch++; pending.resolve(success(null));
  const result = await reply; assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'CLOCK_UNCERTAIN');
});

test('preload blocks out-of-order replies and clears on the first frame before power events', async () => {
  let epoch: number | null = 3, clears = 0;
  const barrier = new RendererBarrier(() => epoch, () => { clears++; });
  const waiting = deferred<string>();
  const old = barrier.deliver(() => waiting.promise);
  epoch = 4;
  barrier.check(); // First post-wake rendering callback; no IPC invalidate event yet.
  assert.equal(clears, 1);
  waiting.resolve('protected old bytes'); await assert.rejects(old, uncertain);
  epoch = null; assert.throws(() => barrier.check(), uncertain); assert.equal(clears, 2);
  assert.throws(() => barrier.check(), uncertain); assert.equal(clears, 2);
  epoch = 5; assert.equal(await barrier.deliver(async () => 'fresh bytes'), 'fresh bytes');
  const hidden = deferred<string>(); const reply = barrier.deliver(() => hidden.promise);
  barrier.invalidate(); hidden.resolve('reply while hidden'); await assert.rejects(reply, uncertain);
});
