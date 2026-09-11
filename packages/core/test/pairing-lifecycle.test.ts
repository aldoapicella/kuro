import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Result, VerifiedPairingPort } from '@kuro/contracts';
import { makeWorld, ok } from './world.js';

type World = Awaited<ReturnType<typeof makeWorld>>;

function delayNextConsume(pairing: VerifiedPairingPort) {
  const consume = pairing.consume.bind(pairing);
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  pairing.consume = async selectionId => {
    entered();
    await blocked;
    return consume(selectionId);
  };
  return { waiting, release };
}

function assertCancelled(result: Result<unknown>): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'CANCELLED');
}

async function crossRecovery(
  node: World['owner'] | World['requester'],
  operation: () => Promise<Result<unknown>>,
): Promise<Result<unknown>> {
  const delayed = delayNextConsume(node.pairing);
  const pending = operation();
  await delayed.waiting;
  node.core.suspend();
  await node.core.resume(true);
  delayed.release();
  return pending;
}

test('pairing selections cannot mutate authority state after lifecycle recovery', async t => {
  await t.test('pairSpace', async () => {
    const world = await makeWorld();
    try {
      const targetSpace = 'd'.repeat(32);
      const selectionId = world.requester.pairing.verify({
        kind: 'authority', spaceId: targetSpace, authorityKey: 'c'.repeat(64), spaceAlias: 'e'.repeat(32),
      });
      const before = world.inspect('requester', 'SELECT space_id FROM authority_spaces').length;
      const result = await crossRecovery(world.requester, () => world.requester.core.app.pairSpace({ selectionId, localActions: ['read'] }));
      assertCancelled(result);
      assert.equal(world.inspect('requester', 'SELECT space_id FROM authority_spaces').length, before);
      assert.equal(world.inspect('requester', `SELECT space_id FROM authority_spaces WHERE space_id='${targetSpace}'`).length, 0);
    } finally { await world.close(); }
  });

  await t.test('enrollMember', async () => {
    const world = await makeWorld();
    try {
      const memberId = '3'.repeat(32);
      const selectionId = world.owner.pairing.verify({
        kind: 'member', spaceId: world.spaceId, memberId, peerKey: 'c'.repeat(64), spaceAlias: 'd'.repeat(32),
      });
      const space = ok(await world.owner.core.app.getState({})).spaces.find(value => value.spaceId === world.spaceId)!;
      const result = await crossRecovery(world.owner, () => world.owner.core.app.enrollMember({
        spaceId: world.spaceId, selectionId, capabilities: ['read'], validUntilMs: null, expectedRevision: space.policyRevision,
      }));
      assertCancelled(result);
      assert.equal(world.inspect('owner', `SELECT member_id FROM authority_members WHERE member_id='${memberId}'`).length, 0);
    } finally { await world.close(); }
  });

  await t.test('replaceAuthority', async () => {
    const world = await makeWorld();
    try {
      const targetSpace = 'd'.repeat(32);
      const selectionId = world.requester.pairing.verify({
        kind: 'authority', spaceId: targetSpace, authorityKey: 'c'.repeat(64), spaceAlias: 'e'.repeat(32),
      });
      const space = ok(await world.requester.core.app.getState({})).spaces.find(value => value.spaceId === world.spaceId)!;
      const result = await crossRecovery(world.requester, () => world.requester.core.app.replaceAuthority({
        oldSpaceId: world.spaceId, selectionId, expectedRevision: space.policyEpoch,
        capabilities: ['read'], localActions: ['read'],
      }));
      assertCancelled(result);
      assert.equal(world.inspect('requester', `SELECT space_id FROM authority_spaces WHERE space_id='${targetSpace}'`).length, 0);
      assert.equal((world.inspect('requester', `SELECT tombstoned FROM authority_spaces WHERE space_id='${world.spaceId}'`)[0] as { tombstoned: number }).tombstoned, 0);
    } finally { await world.close(); }
  });

  await t.test('pairPeer', async () => {
    const world = await makeWorld();
    try {
      const alias = 'd'.repeat(32);
      const selectionId = world.owner.pairing.verify({
        kind: 'peer', spaceId: world.spaceId, peerKey: world.requester.key, spaceAlias: alias,
      });
      const result = await crossRecovery(world.owner, () => world.owner.core.app.pairPeer({ selectionId }));
      assertCancelled(result);
      assert.equal(world.inspect('owner', `SELECT peer_key FROM local_peer_aliases WHERE peer_key='${world.requester.key}'`).length, 0);
    } finally { await world.close(); }
  });
});

test('same-epoch setup pairing remains available while the authorization gate is closed', async () => {
  const world = await makeWorld();
  try {
    world.requester.core.suspend();
    await world.requester.core.resume(false);
    const targetSpace = 'd'.repeat(32);
    const selectionId = world.requester.pairing.verify({
      kind: 'authority', spaceId: targetSpace, authorityKey: 'c'.repeat(64), spaceAlias: 'e'.repeat(32),
    });
    const paired = ok(await world.requester.core.app.pairSpace({ selectionId, localActions: ['read'] }));
    assert.equal(paired.spaceId, targetSpace);
    assert.equal(paired.syncState, 'STALE');
    assert.equal(ok(await world.requester.core.app.getState({})).clockEpochValid, false);
  } finally { await world.close(); }
});
