import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KuroError, success, failure } from '@kuro/contracts';
import type { CoreLifecyclePort, VerifiedBinding } from '@kuro/contracts';
import { FakeAppPort } from '../src/fake-app.js';
import { unavailableSetup } from '../src/setup-unavailable.js';
import { DesktopLifecycle } from '../src/lifecycle.js';
import { routeCall, trustedSender } from '../src/ipc-router.js';
import { ProtectedSecretStore } from '../src/secret-store.js';
import { formatBindingVerification } from '../src/selections.js';

const lifecycleCore = (overrides: Partial<CoreLifecyclePort> = {}): CoreLifecyclePort => ({
  start: async () => {}, stop: async () => {}, suspend: () => {}, resume: async () => {}, tick: async () => {}, ...overrides,
});

test('IPC trust requires the bound main frame and exact URL', () => {
  const binding = { senderId: 7, url: 'file:///trusted', app: {} as never, host: {} as never };
  assert.equal(trustedSender({ id: 7, isMainFrame: true, url: binding.url }, binding), true);
  assert.equal(trustedSender({ id: 8, isMainFrame: true, url: binding.url }, binding), false);
  assert.equal(trustedSender({ id: 7, isMainFrame: false, url: binding.url }, binding), false);
  assert.equal(trustedSender({ id: 7, isMainFrame: true, url: 'file:///other' }, binding), false);
});

test('pairing verification covers every trusted binding field', () => {
  const binding: VerifiedBinding = {
    kind: 'member', spaceId: '1'.repeat(32), memberId: '2'.repeat(32), peerKey: '3'.repeat(64), spaceAlias: '4'.repeat(32),
  };
  const shown = formatBindingVerification(binding);
  for (const value of ['Type: member', binding.spaceId, binding.memberId, binding.peerKey, binding.spaceAlias]) assert.ok(shown.includes(value));
  for (const changed of [
    { ...binding, spaceId: '5'.repeat(32) },
    { ...binding, memberId: '6'.repeat(32) },
    { ...binding, peerKey: '7'.repeat(64) },
    { ...binding, spaceAlias: '8'.repeat(32) },
  ]) assert.notEqual(formatBindingVerification(changed), shown);

  const authority: VerifiedBinding = { kind: 'authority', spaceId: binding.spaceId, authorityKey: '9'.repeat(64), spaceAlias: binding.spaceAlias };
  const peer: VerifiedBinding = { kind: 'peer', spaceId: binding.spaceId, peerKey: 'a'.repeat(64), spaceAlias: binding.spaceAlias };
  for (const [value, expected] of [[authority, authority.authorityKey], [peer, peer.peerKey]] as const) {
    const details = formatBindingVerification(value);
    assert.ok(details.includes(`Type: ${value.kind}`));
    assert.ok(details.includes(expected));
    assert.ok(details.includes(value.spaceId));
    assert.ok(details.includes(value.spaceAlias));
  }
});

test('suspend gates every core even when one barrier fails', () => {
  const suspended: string[] = [];
  const lifecycle = new DesktopLifecycle([
    lifecycleCore({ suspend: () => { suspended.push('first'); throw new Error('storage failed'); } }),
    lifecycleCore({ suspend: () => { suspended.push('second'); } }),
  ]);
  assert.throws(() => lifecycle.suspend(), /storage failed/);
  assert.deepEqual(suspended, ['first', 'second']);
});

test('a failed tick does not prevent the next lifecycle tick', async () => {
  let calls = 0;
  const lifecycle = new DesktopLifecycle([lifecycleCore({ tick: async () => { calls++; if (calls === 1) throw new Error('transient'); } })]);
  await assert.rejects(lifecycle.tick(), /transient/);
  await lifecycle.tick();
  assert.equal(calls, 2);
});

test('shutdown still stops every core after a suspend barrier fails', async () => {
  const stopped: string[] = [];
  const lifecycle = new DesktopLifecycle([
    lifecycleCore({ suspend: () => { throw new Error('storage failed'); }, stop: async () => { stopped.push('first'); } }),
    lifecycleCore({ stop: async () => { stopped.push('second'); } }),
  ]);
  await assert.rejects(lifecycle.close(), /KURO shutdown failed/);
  assert.deepEqual(stopped, ['first', 'second']);
});

test('protected secret creation returns one concurrent winner and cleans failed writes', async () => {
  const raw = await mkdtemp(join(tmpdir(), 'kuro-secret-store-'));
  const directory = await realpath(raw);
  const protector = {
    protection: () => 'os-protected' as const,
    encrypt: (text: string) => new Uint8Array(Buffer.from(text)),
    decrypt: (bytes: Uint8Array) => Buffer.from(bytes).toString(),
  };
  try {
    const store = new ProtectedSecretStore(directory, protector);
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => store.createIfAbsent('identity', Uint8Array.of(index + 1))));
    assert.equal(new Set(results.map(value => Buffer.from(value).toString('hex'))).size, 1);

    const failing = new ProtectedSecretStore(directory, { ...protector, encrypt: () => { throw new Error('protector failed'); } });
    await assert.rejects(failing.createIfAbsent('other-identity', Uint8Array.of(1)), /protector failed/);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.pending')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('closed authorization still permits bounded setup and stop, never protected IPC', async () => {
  const fake = new FakeAppPort('A');
  let stopped = 0;
  const host = { ...unavailableSetup(fake.info()), selectText: async () => success(null), selectPairing: async () => success(null), setScenario: async () => failure('ACCESS_DENIED'), getInfo: async () => success(fake.info()), stopWorkspace: async () => { stopped++; return success(null); } };
  const binding = { senderId: 7, url: 'file:///trusted', app: fake.app, host, checkpoint: () => { throw new KuroError('CLOCK_UNCERTAIN'); } };
  const sender = { id: 7, isMainFrame: true, url: binding.url };
  try {
    assert.equal((await routeCall(binding, sender, 'host', 'getSetup', {})).ok, true);
    assert.equal((await routeCall(binding, sender, 'host', 'stopWorkspace', {})).ok, true);
    assert.equal(stopped, 1);
    assert.deepEqual(await routeCall(binding, sender, 'host', 'getInfo', {}), failure('CLOCK_UNCERTAIN'));
    assert.deepEqual(await routeCall(binding, sender, 'app', 'getState', {}), failure('CLOCK_UNCERTAIN'));
    assert.equal((await routeCall(binding, sender, 'host', 'getSetup', { path: '/private' })).ok, false);
    assert.equal((await routeCall(binding, { ...sender, isMainFrame: false }, 'host', 'stopWorkspace', {})).ok, false);
    assert.equal(stopped, 1);
  } finally { fake.close(); }
});
