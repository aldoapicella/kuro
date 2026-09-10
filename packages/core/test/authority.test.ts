import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeWire, encodeWire, KuroError, projectionDigest } from '@kuro/contracts';
import type { Clock, IdSource, LocalSession, SessionPort, VerifiedBinding, VerifiedPairingPort } from '@kuro/contracts';
import { Authority } from '../src/authority.js';
import { Store } from '../src/store.js';

const id = (value: string) => value.repeat(32).slice(0, 32);
const key = (value: string) => value.repeat(64).slice(0, 64);

class FakeClock implements Clock {
  wall = 100_000;
  mono = 5_000;
  wallNowMs(): number { return this.wall; }
  monotonicNowMs(): number { return this.mono; }
  advance(ms: number): void { this.wall += ms; this.mono += ms; }
}
class FakeIds implements IdSource {
  #next = 1;
  nextId(): string { return (this.#next++).toString(16).padStart(32, '0'); }
  randomUnit(): number { return 0; }
}
class FakeSession implements SessionPort {
  constructor(public value: LocalSession | null) {}
  current(): LocalSession | null { return this.value; }
}
class FakePairing implements VerifiedPairingPort {
  readonly values = new Map<string, VerifiedBinding>();
  async consume(selectionId: string): Promise<VerifiedBinding> {
    const value = this.values.get(selectionId);
    this.values.delete(selectionId);
    if (!value) throw new KuroError('INVALID_INPUT');
    return value;
  }
}

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof KuroError && error.code === code);
}

async function setup(validUntilMs: number | null = null, memberPath = ':memory:', memberFault?: (point: string) => void) {
  const ownerClock = new FakeClock();
  const memberClock = new FakeClock();
  const ownerStore = new Store(':memory:');
  const memberStore = new Store(memberPath, memberFault);
  const ownerKey = key('a');
  const memberKey = key('b');
  const ownerId = id('1');
  const memberId = id('2');
  const ownerSession = new FakeSession({ memberId: ownerId, deviceKey: ownerKey, validUntilMs: 999_999_999 });
  const memberSession = new FakeSession({ memberId, deviceKey: memberKey, validUntilMs: 999_999_999 });
  const ownerPairing = new FakePairing();
  const memberPairing = new FakePairing();
  const ownerInvalidations: string[] = [];
  const memberInvalidations: string[] = [];
  const owner = new Authority(ownerStore, { clock: ownerClock, ids: new FakeIds(), sessions: ownerSession, pairing: ownerPairing, publicKey: ownerKey, invalidate: (space, reason) => ownerInvalidations.push(`${space}:${reason}`) });
  const member = new Authority(memberStore, { clock: memberClock, ids: new FakeIds(), sessions: memberSession, pairing: memberPairing, publicKey: memberKey, invalidate: (space, reason) => memberInvalidations.push(`${space}:${reason}`) });
  owner.startup(); owner.resume(true);
  member.startup(); member.resume(true);
  const space = owner.createSpace({ capabilities: ['search', 'read', 'share', 'receive', 'manage'], localActions: ['search', 'read', 'share', 'receive', 'manage'] });
  const authorityAlias = id('c');
  const memberAlias = id('d');
  ownerPairing.values.set(id('3'), { kind: 'member', spaceId: space.spaceId, memberId, peerKey: memberKey, spaceAlias: memberAlias });
  await owner.enrollMember({ spaceId: space.spaceId, selectionId: id('3'), capabilities: ['search', 'read', 'receive', 'manage'], validUntilMs, expectedRevision: 1 });
  owner.setRelationship({ spaceId: space.spaceId, memberId: ownerId, otherMemberId: memberId, allowed: true, validUntilMs, expectedRevision: 2 });
  memberPairing.values.set(id('4'), { kind: 'authority', spaceId: space.spaceId, authorityKey: ownerKey, spaceAlias: memberAlias });
  await member.pairSpace({ selectionId: id('4'), localActions: ['search', 'read', 'receive', 'manage'] });
  return { owner, member, ownerClock, memberClock, ownerStore, memberStore, ownerPairing, memberPairing, ownerSession, memberSession, ownerKey, memberKey, ownerId, memberId, spaceId: space.spaceId, memberAlias, authorityAlias, ownerInvalidations, memberInvalidations };
}

function sync(owner: Authority, member: Authority, spaceId: string, ownerKey: string) {
  const send = member.beginSync(spaceId);
  assert.equal(send.peerKey, ownerKey);
  const request = decodeWire(send.bytes);
  assert.equal(request.type, 'SPACE_STATE_REQUEST');
  if (request.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
  const bytes = owner.handleRequest(send.peerKey === ownerKey ? key('b') : '', request);
  const response = decodeWire(bytes);
  assert.equal(response.type, 'SPACE_STATE_RESPONSE');
  if (response.type !== 'SPACE_STATE_RESPONSE') throw new Error('expected response');
  member.handleResponse(ownerKey, response, bytes);
  return { request, response, bytes };
}

test('default deny, explicit local policy and document ACL intersect the shared ceiling', async () => {
  const state = await setup();
  try {
    sync(state.owner, state.member, state.spaceId, state.ownerKey);
    expectCode('ACCESS_DENIED', () => state.owner.authorizePeer(state.spaceId, state.memberKey, 'read'));
    state.owner.setLocalPolicy({ spaceId: state.spaceId, memberId: state.memberId, admitted: true, actions: ['read'], validUntilMs: null, expectedRevision: state.owner.getSpace(state.spaceId).policyEpoch });
    assert.equal(state.owner.authorizePeer(state.spaceId, state.memberKey, 'read'), state.memberId);
    expectCode('ACCESS_DENIED', () => state.owner.assertDocument(state.spaceId, id('9'), state.memberId, 'read'));
    state.owner.setDocumentRules({ spaceId: state.spaceId, documentId: id('9'), rules: [{ memberId: state.memberId, actions: ['read'], validUntilMs: null }], expectedRevision: 0 });
    state.owner.assertDocument(state.spaceId, id('9'), state.memberId, 'read');
    const predicate = state.owner.documentPredicate(state.spaceId, state.memberId, 'read');
    assert.match(predicate.sql, /document_acl/);
    assert.ok(predicate.params.includes(state.spaceId));
    expectCode('ACCESS_DENIED', () => state.owner.authorizePeer(state.spaceId, state.memberKey, 'share'));
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('sync replay is byte exact and installation retains original-send lease anchors', async () => {
  const state = await setup();
  try {
    const send = state.member.beginSync(state.spaceId);
    const request = decodeWire(send.bytes);
    assert.equal(request.type, 'SPACE_STATE_REQUEST');
    if (request.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
    state.memberClock.advance(4_000);
    const first = state.owner.handleRequest(state.memberKey, request);
    const replay = state.owner.handleRequest(state.memberKey, request);
    assert.deepEqual(replay, first);
    const response = decodeWire(first);
    assert.equal(response.type, 'SPACE_STATE_RESPONSE');
    if (response.type !== 'SPACE_STATE_RESPONSE') throw new Error('unreachable');
    state.member.handleResponse(state.ownerKey, response, first);
    assert.equal(state.member.getSpace(state.spaceId).remainingValidityMs, response.validForMs - 4_000);
    state.member.handleResponse(state.ownerKey, response, first); // exact accepted duplicate is harmless
    assert.equal(state.member.getSpace(state.spaceId).remainingValidityMs, response.validForMs - 4_000);
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('policy mutation closes an issued request instead of rewriting stale bytes', async () => {
  const state = await setup();
  try {
    const send = state.member.beginSync(state.spaceId);
    const request = decodeWire(send.bytes);
    if (request.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
    const issued = state.owner.handleRequest(state.memberKey, request);
    state.owner.setMember({ spaceId: state.spaceId, memberId: state.memberId, active: false, capabilities: [], validUntilMs: null, expectedRevision: 3 });
    const stale = state.owner.revalidatePublication(state.memberKey, request.requestId);
    assert.equal(decodeWire(stale).type, 'CLOSED');
    assert.notDeepEqual(stale, issued);
    assert.equal(state.owner.handleRequest(state.memberKey, request).toString(), stale.toString());
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('suspend closes the gate immediately and resume leaves participant cache stale', async () => {
  const state = await setup();
  try {
    sync(state.owner, state.member, state.spaceId, state.ownerKey);
    assert.equal(state.member.authorizeLocal(state.spaceId, 'read'), state.memberId);
    state.member.suspend();
    expectCode('CLOCK_UNCERTAIN', () => state.member.authorizeLocal(state.spaceId, 'read'));
    state.member.resume(true);
    assert.equal(state.member.clockEpochValid, true);
    assert.equal(state.member.getSpace(state.spaceId).syncState, 'STALE');
    expectCode('EXPIRED', () => state.member.authorizeLocal(state.spaceId, 'read'));
    assert.ok(state.memberInvalidations.some((value) => value.endsWith(':stale')));
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('scheduled authority expiry shortens lease and invalidates at both deadlines', async () => {
  const state = await setup(112_000);
  try {
    const { response } = sync(state.owner, state.member, state.spaceId, state.ownerKey);
    assert.equal(response.validForMs, 12_000);
    state.memberClock.advance(12_000);
    state.member.tick();
    assert.equal(state.member.getSpace(state.spaceId).syncState, 'EXPIRED');
    expectCode('EXPIRED', () => state.member.authorizeLocal(state.spaceId, 'read'));
    assert.ok(state.memberInvalidations.some((value) => value.endsWith(':expired')));
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('lower counters are rejected and do not replace a current cache', async () => {
  const state = await setup();
  try {
    const first = sync(state.owner, state.member, state.spaceId, state.ownerKey);
    state.ownerClock.advance(5_000); state.memberClock.advance(5_000);
    const send = state.member.beginSync(state.spaceId);
    const request = decodeWire(send.bytes);
    if (request.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
    const bytes = state.owner.handleRequest(state.memberKey, request);
    const current = decodeWire(bytes);
    if (current.type !== 'SPACE_STATE_RESPONSE') throw new Error('unreachable');
    const lowerBody = { ...current, publicationSeq: first.response.publicationSeq };
    const lower = { ...lowerBody, projectionDigest: projectionDigest(lowerBody) };
    expectCode('INVALID_MESSAGE', () => state.member.handleResponse(state.ownerKey, lower, encodeWire(lower)));
    assert.equal(state.member.getSpace(state.spaceId).policyRevision, first.response.policyRevision);
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('unknown authority binding gets only generic CLOSED', async () => {
  const state = await setup();
  try {
    const bytes = state.owner.handleRequest(key('e'), { v: 1, type: 'SPACE_STATE_REQUEST', requestId: id('e'), spaceAlias: state.memberAlias });
    assert.deepEqual(decodeWire(bytes), { requestId: id('e'), spaceAlias: state.memberAlias, type: 'CLOSED', v: 1 });
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('failed SQLite commit cannot install or extend a renewal', async () => {
  let armed = false;
  const state = await setup(null, ':memory:', (point) => { if (armed && point === 'before_commit') throw new Error('fault'); });
  try {
    sync(state.owner, state.member, state.spaceId, state.ownerKey);
    state.ownerClock.advance(5_000); state.memberClock.advance(5_000);
    const before = state.member.getSpace(state.spaceId).remainingValidityMs;
    const send = state.member.beginSync(state.spaceId);
    const request = decodeWire(send.bytes);
    if (request.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
    const bytes = state.owner.handleRequest(state.memberKey, request);
    const response = decodeWire(bytes);
    if (response.type !== 'SPACE_STATE_RESPONSE') throw new Error('unreachable');
    armed = true;
    expectCode('STORAGE_FAILURE', () => state.member.handleResponse(state.ownerKey, response, bytes));
    armed = false;
    assert.equal(state.member.getSpace(state.spaceId).remainingValidityMs, before);
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('restart preserves counters and exact accepted bytes while requiring a fresh sync', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kuro-authority-'));
  const path = join(directory, 'participant.sqlite');
  const state = await setup(null, path);
  try {
    const accepted = sync(state.owner, state.member, state.spaceId, state.ownerKey);
    state.memberStore.close();
    const reopenedStore = new Store(path);
    const reopened = new Authority(reopenedStore, {
      clock: state.memberClock, ids: new FakeIds(), sessions: state.memberSession, pairing: state.memberPairing,
      publicKey: state.memberKey, invalidate: (_space, reason) => state.memberInvalidations.push(`restart:${reason}`),
    });
    try {
      reopened.startup(); reopened.resume(true);
      assert.equal(reopened.getSpace(state.spaceId).syncState, 'STALE');
      reopened.handleResponse(state.ownerKey, accepted.response, accepted.bytes);
      assert.equal(reopened.getSpace(state.spaceId).syncState, 'STALE');
      assert.ok(state.memberInvalidations.includes('restart:stale'));
    } finally { reopenedStore.close(); }
  } finally {
    state.ownerStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('resume discards pre-suspend sync correlation and requires a new request epoch', async () => {
  const state = await setup();
  try {
    const oldSend = state.member.beginSync(state.spaceId);
    const oldRequest = decodeWire(oldSend.bytes);
    if (oldRequest.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
    const oldBytes = state.owner.handleRequest(state.memberKey, oldRequest);
    const oldResponse = decodeWire(oldBytes);
    if (oldResponse.type !== 'SPACE_STATE_RESPONSE') throw new Error('unreachable');
    state.member.suspend();
    state.member.resume(true);
    expectCode('INVALID_MESSAGE', () => state.member.handleResponse(state.ownerKey, oldResponse, oldBytes));
    const freshSend = state.member.beginSync(state.spaceId);
    assert.notEqual(freshSend.requestId, oldSend.requestId);
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('clock rollback closes authorization before a protected operation can proceed', async () => {
  const state = await setup();
  try {
    sync(state.owner, state.member, state.spaceId, state.ownerKey);
    const trustedWall = state.memberClock.wall;
    state.memberClock.wall -= 1;
    expectCode('CLOCK_UNCERTAIN', () => state.member.authorizeLocal(state.spaceId, 'read'));
    assert.equal(state.member.clockEpochValid, false);
    assert.equal(state.member.getSpace(state.spaceId).syncState, 'STALE');
    expectCode('CLOCK_UNCERTAIN', () => state.member.resume(true));
    state.memberClock.wall = trustedWall;
    expectCode('CLOCK_UNCERTAIN', () => state.member.authorizeLocal(state.spaceId, 'read'));
    assert.equal(state.member.clockEpochValid, false);
    state.member.resume(true);
    assert.equal(state.member.clockEpochValid, true);
    expectCode('EXPIRED', () => state.member.authorizeLocal(state.spaceId, 'read'));
    assert.ok(state.memberInvalidations.some((value) => value.endsWith(':stale')));
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('normal refresh is queued with a new ID and a timed-out request backs off', async () => {
  const state = await setup();
  try {
    const accepted = sync(state.owner, state.member, state.spaceId, state.ownerKey);
    state.memberClock.advance(60_000);
    state.member.tick();
    const sends = state.member.pendingSyncSends();
    assert.equal(sends.length, 1);
    assert.notEqual(sends[0]?.requestId, accepted.request.requestId);
    state.memberClock.advance(10_000);
    state.member.tick();
    assert.equal(state.member.pendingSyncSends().length, 0);
    assert.equal(state.member.getSpace(state.spaceId).syncState, 'OFFLINE_VALID');
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('a removed known device receives a replayable zero-duration denial', async () => {
  const state = await setup();
  try {
    state.owner.setMember({ spaceId: state.spaceId, memberId: state.memberId, active: false, capabilities: [], validUntilMs: null, expectedRevision: 3 });
    const request = { v: 1 as const, type: 'SPACE_STATE_REQUEST' as const, requestId: id('f'), spaceAlias: state.memberAlias };
    const first = state.owner.handleRequest(state.memberKey, request);
    const decoded = decodeWire(first);
    assert.equal(decoded.type, 'SPACE_STATE_RESPONSE');
    if (decoded.type !== 'SPACE_STATE_RESPONSE') throw new Error('unreachable');
    assert.equal(decoded.status, 'DENIED');
    assert.equal(decoded.validForMs, 0);
    assert.deepEqual(state.owner.handleRequest(state.memberKey, request), first);
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('manage capability never turns a participant into the pinned owner', async () => {
  const state = await setup();
  try {
    sync(state.owner, state.member, state.spaceId, state.ownerKey);
    expectCode('ACCESS_DENIED', () => state.member.setMember({ spaceId: state.spaceId, memberId: state.ownerId, active: false, capabilities: [], validUntilMs: null, expectedRevision: 3 }));
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('response installation rejects wrong origin, binding, correlation, and duplicate projection identities', async () => {
  const state = await setup();
  try {
    const send = state.member.beginSync(state.spaceId);
    const request = decodeWire(send.bytes);
    if (request.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
    const exact = state.owner.handleRequest(state.memberKey, request);
    const response = decodeWire(exact);
    if (response.type !== 'SPACE_STATE_RESPONSE') throw new Error('unreachable');
    const variant = (changes: Partial<typeof response>) => {
      const changed = { ...response, ...changes };
      const { projectionDigest: _old, ...body } = changed;
      return { ...body, projectionDigest: projectionDigest(body) };
    };
    expectCode('INVALID_MESSAGE', () => state.member.handleResponse(key('c'), response, exact));
    for (const changed of [
      variant({ authorityKey: key('c') }), variant({ recipientKey: key('c') }),
      variant({ spaceAlias: id('e') }), variant({ spaceId: id('e') }), variant({ requestId: id('e') }),
    ]) expectCode('INVALID_MESSAGE', () => state.member.handleResponse(state.ownerKey, changed, new TextEncoder().encode(JSON.stringify(changed))));
    const duplicate = { ...response, members: [response.members[0]!, response.members[0]!], projectionDigest: key('0') };
    expectCode('INVALID_MESSAGE', () => state.member.handleResponse(state.ownerKey, duplicate, new TextEncoder().encode(JSON.stringify(duplicate))));
    const duplicateKey = { ...response, members: response.members.map((member, index) => index ? { ...member, deviceKeys: [response.members[0]!.deviceKeys[0]!] } : member), projectionDigest: key('0') };
    expectCode('INVALID_MESSAGE', () => state.member.handleResponse(state.ownerKey, duplicateKey, new TextEncoder().encode(JSON.stringify(duplicateKey))));
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('same-policy renewal preserves work while a conflicting same-policy projection is rejected', async () => {
  const state = await setup();
  try {
    const first = sync(state.owner, state.member, state.spaceId, state.ownerKey);
    const epoch = state.member.getSpace(state.spaceId).policyEpoch;
    const invalidations = state.memberInvalidations.length;
    state.ownerClock.advance(5_000); state.memberClock.advance(5_000);
    const send = state.member.beginSync(state.spaceId);
    const request = decodeWire(send.bytes);
    if (request.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
    const bytes = state.owner.handleRequest(state.memberKey, request);
    const renewal = decodeWire(bytes);
    if (renewal.type !== 'SPACE_STATE_RESPONSE') throw new Error('unreachable');
    assert.equal(renewal.policyRevision, first.response.policyRevision);
    assert.equal(renewal.projectionDigest, first.response.projectionDigest);
    const changedMembers = renewal.members.map((member, index) => index ? member : { ...member, capabilities: member.capabilities.filter((capability) => capability !== 'read') });
    const { projectionDigest: _old, ...changedBody } = { ...renewal, members: changedMembers };
    const conflict = { ...changedBody, projectionDigest: projectionDigest(changedBody) };
    expectCode('INVALID_MESSAGE', () => state.member.handleResponse(state.ownerKey, conflict, encodeWire(conflict)));
    const { projectionDigest: _lowerOld, ...lowerBody } = { ...renewal, policyRevision: renewal.policyRevision - 1 };
    const lowerPolicy = { ...lowerBody, projectionDigest: projectionDigest(lowerBody) };
    expectCode('INVALID_MESSAGE', () => state.member.handleResponse(state.ownerKey, lowerPolicy, encodeWire(lowerPolicy)));
    state.member.handleResponse(state.ownerKey, renewal, bytes);
    assert.equal(state.member.getSpace(state.spaceId).policyEpoch, epoch);
    assert.equal(state.memberInvalidations.length, invalidations);
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('same-policy renewal after an unnoticed lease lapse invalidates work before installing fresh state', async () => {
  const state = await setup();
  try {
    sync(state.owner, state.member, state.spaceId, state.ownerKey);
    const oldEpoch = state.member.getSpace(state.spaceId).policyEpoch;
    const oldExpiryInvalidations = state.memberInvalidations.filter((value) => value.endsWith(':expired')).length;
    state.ownerClock.advance(899_000);
    state.memberClock.advance(899_000);
    const send = state.member.beginSync(state.spaceId);
    const request = decodeWire(send.bytes);
    if (request.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
    const bytes = state.owner.handleRequest(state.memberKey, request);
    const response = decodeWire(bytes);
    if (response.type !== 'SPACE_STATE_RESPONSE') throw new Error('unreachable');
    state.memberClock.advance(1_001);
    state.member.handleResponse(state.ownerKey, response, bytes);
    const renewed = state.member.getSpace(state.spaceId);
    assert.equal(renewed.syncState, 'CURRENT');
    assert.equal(renewed.policyEpoch, oldEpoch + 1);
    assert.equal(state.memberInvalidations.filter((value) => value.endsWith(':expired')).length, oldExpiryInvalidations + 1);
    assert.equal(state.member.authorizeLocal(state.spaceId, 'read'), state.memberId);
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('a newer complete projection removes a peer instead of merging cached members', async () => {
  const state = await setup();
  const thirdId = id('7');
  const thirdKey = key('7');
  try {
    state.ownerPairing.values.set(id('7'), { kind: 'member', spaceId: state.spaceId, memberId: thirdId, peerKey: thirdKey, spaceAlias: id('8') });
    await state.owner.enrollMember({ spaceId: state.spaceId, selectionId: id('7'), capabilities: ['read'], validUntilMs: null, expectedRevision: 3 });
    state.owner.setRelationship({ spaceId: state.spaceId, memberId: state.memberId, otherMemberId: thirdId, allowed: true, validUntilMs: null, expectedRevision: 4 });
    sync(state.owner, state.member, state.spaceId, state.ownerKey);
    state.member.setLocalPolicy({ spaceId: state.spaceId, memberId: thirdId, admitted: true, actions: ['read'], validUntilMs: null, expectedRevision: state.member.getSpace(state.spaceId).policyEpoch });
    assert.equal(state.member.authorizePeer(state.spaceId, thirdKey, 'read'), thirdId);
    state.owner.setMember({ spaceId: state.spaceId, memberId: thirdId, active: false, capabilities: [], validUntilMs: null, expectedRevision: 5 });
    state.ownerClock.advance(5_000); state.memberClock.advance(5_000);
    sync(state.owner, state.member, state.spaceId, state.ownerKey);
    expectCode('ACCESS_DENIED', () => state.member.authorizePeer(state.spaceId, thirdKey, 'read'));
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('projection and key bounds fail closed without truncation', async () => {
  const state = await setup();
  try {
    let revision = 3;
    for (let index = 0; index < 15; index++) {
      const suffix = (index + 3).toString(16);
      const memberId = suffix.padStart(32, '0');
      const peerKey = suffix.padStart(64, '0');
      const selectionId = (index + 16).toString(16).padStart(32, '0');
      state.ownerPairing.values.set(selectionId, { kind: 'member', spaceId: state.spaceId, memberId, peerKey, spaceAlias: (index + 64).toString(16).padStart(32, '0') });
      await state.owner.enrollMember({ spaceId: state.spaceId, selectionId, capabilities: ['read'], validUntilMs: null, expectedRevision: revision++ });
      state.owner.setRelationship({ spaceId: state.spaceId, memberId: state.memberId, otherMemberId: memberId, allowed: true, validUntilMs: null, expectedRevision: revision++ });
    }
    const send = state.member.beginSync(state.spaceId);
    const request = decodeWire(send.bytes);
    if (request.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
    expectCode('CAPACITY_EXCEEDED', () => state.owner.handleRequest(state.memberKey, request));

    const keyState = await setup();
    try {
      let keyRevision = 3;
      for (const suffix of ['c', 'd', 'e']) {
        const selection = id(suffix);
        keyState.ownerPairing.values.set(selection, { kind: 'member', spaceId: keyState.spaceId, memberId: keyState.memberId, peerKey: key(suffix), spaceAlias: id(suffix) });
        await keyState.owner.enrollMember({ spaceId: keyState.spaceId, selectionId: selection, capabilities: ['read'], validUntilMs: null, expectedRevision: keyRevision++ });
      }
      keyState.ownerPairing.values.set(id('f'), { kind: 'member', spaceId: keyState.spaceId, memberId: keyState.memberId, peerKey: key('f'), spaceAlias: id('f') });
      await assert.rejects(keyState.owner.enrollMember({ spaceId: keyState.spaceId, selectionId: id('f'), capabilities: ['read'], validUntilMs: null, expectedRevision: keyRevision }), (error: unknown) => error instanceof KuroError && error.code === 'CAPACITY_EXCEEDED');
    } finally { keyState.ownerStore.close(); keyState.memberStore.close(); }
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('a response delayed past the original request timeout cannot install', async () => {
  const state = await setup();
  try {
    const send = state.member.beginSync(state.spaceId);
    const request = decodeWire(send.bytes);
    if (request.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
    const bytes = state.owner.handleRequest(state.memberKey, request);
    const response = decodeWire(bytes);
    if (response.type !== 'SPACE_STATE_RESPONSE') throw new Error('unreachable');
    state.memberClock.advance(10_000);
    expectCode('EXPIRED', () => state.member.handleResponse(state.ownerKey, response, bytes));
    assert.equal(state.member.getSpace(state.spaceId).syncState, 'STALE');
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('installed denial remains authoritative while refresh is in flight', async () => {
  const state = await setup();
  try {
    sync(state.owner, state.member, state.spaceId, state.ownerKey);
    state.owner.setMember({ spaceId: state.spaceId, memberId: state.memberId, active: false, capabilities: [], validUntilMs: null, expectedRevision: 3 });
    state.ownerClock.advance(5_000); state.memberClock.advance(5_000);
    const send = state.member.beginSync(state.spaceId);
    const request = decodeWire(send.bytes);
    if (request.type !== 'SPACE_STATE_REQUEST') throw new Error('unreachable');
    const bytes = state.owner.handleRequest(state.memberKey, request);
    const denial = decodeWire(bytes);
    if (denial.type !== 'SPACE_STATE_RESPONSE') throw new Error('unreachable');
    state.member.handleResponse(state.ownerKey, denial, bytes);
    assert.equal(state.member.getSpace(state.spaceId).syncState, 'DENIED');
    state.memberClock.advance(60_000); state.member.tick();
    assert.equal(state.member.getSpace(state.spaceId).syncState, 'DENIED');
    expectCode('ACCESS_DENIED', () => state.member.authorizeLocal(state.spaceId, 'read'));
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('participant recovery tombstones the old namespace and stages no shared grant', async () => {
  const state = await setup();
  try {
    sync(state.owner, state.member, state.spaceId, state.ownerKey);
    state.memberPairing.values.set(id('9'), { kind: 'authority', spaceId: id('9'), authorityKey: key('9'), spaceAlias: id('9') });
    const replacement = await state.member.replaceAuthority({ oldSpaceId: state.spaceId, selectionId: id('9'), expectedRevision: state.member.getSpace(state.spaceId).policyEpoch, capabilities: ['manage'], localActions: ['manage'] });
    assert.equal(replacement.spaceId, id('9'));
    assert.equal(replacement.syncState, 'STALE');
    assert.equal(state.member.getSpace(state.spaceId).syncState, 'DENIED');
    expectCode('ACCESS_DENIED', () => state.member.authorizeLocal(state.spaceId, 'read'));
    expectCode('INVALID_INPUT', () => state.member.beginSync(state.spaceId));
    expectCode('EXPIRED', () => state.member.authorizeLocal(replacement.spaceId, 'manage'));
    assert.equal(state.memberStore.get<{ n: number }>('SELECT count(*) n FROM authority_spaces WHERE space_id=? AND tombstoned=1', state.spaceId)?.n, 1);
    assert.equal(state.memberStore.get<{ publication_seq: number }>('SELECT cache_publication_seq publication_seq FROM authority_spaces WHERE space_id=?', state.spaceId)?.publication_seq, 1);
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('rotated owner recovery starts counters only in a fresh explicit namespace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kuro-owner-recovery-'));
  const path = join(directory, 'owner.sqlite');
  const oldKey = key('a');
  const newKey = key('c');
  const memberId = id('1');
  const clock = new FakeClock();
  const ids = new FakeIds();
  const oldStore = new Store(path);
  const old = new Authority(oldStore, { clock, ids, sessions: new FakeSession({ memberId, deviceKey: oldKey, validUntilMs: 999_999 }), pairing: new FakePairing(), publicKey: oldKey, invalidate: () => {} });
  old.startup(); old.resume(true);
  const oldSpace = old.createSpace({ capabilities: ['manage'], localActions: ['manage'] });
  oldStore.close();
  const pairing = new FakePairing();
  pairing.values.set(id('a'), { kind: 'authority', spaceId: id('b'), authorityKey: newKey, spaceAlias: id('c') });
  const store = new Store(path);
  const recovered = new Authority(store, { clock, ids: new FakeIds(), sessions: new FakeSession({ memberId, deviceKey: newKey, validUntilMs: 999_999 }), pairing, publicKey: newKey, invalidate: () => {} });
  try {
    recovered.startup(); recovered.resume(true);
    const next = await recovered.replaceAuthority({ oldSpaceId: oldSpace.spaceId, selectionId: id('a'), expectedRevision: oldSpace.policyEpoch, capabilities: ['read', 'manage'], localActions: ['read', 'manage'] });
    assert.equal(next.isOwner, true);
    assert.equal(next.policyRevision, 1);
    assert.equal(recovered.authorizeLocal(next.spaceId, 'read'), memberId);
    assert.equal(recovered.getSpace(oldSpace.spaceId).syncState, 'DENIED');
    expectCode('ACCESS_DENIED', () => recovered.setMember({ spaceId: oldSpace.spaceId, memberId, active: true, capabilities: ['manage'], validUntilMs: null, expectedRevision: 1 }));
    assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM publication_counters WHERE space_id=?', next.spaceId)?.n, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('monotonic rollback closes the epoch, invalidates owner work, and participant resume still requires sync', async () => {
  const state = await setup();
  try {
    sync(state.owner, state.member, state.spaceId, state.ownerKey);
    state.ownerInvalidations.length = 0;
    state.ownerClock.mono -= 1;
    expectCode('CLOCK_UNCERTAIN', () => state.owner.authorizeLocal(state.spaceId, 'read'));
    assert.equal(state.owner.clockEpochValid, false);
    assert.ok(state.ownerInvalidations.some((value) => value.endsWith(':stale')));
    state.owner.resume(true);
    assert.equal(state.owner.authorizeLocal(state.spaceId, 'read'), state.ownerId);

    state.memberClock.mono -= 1;
    expectCode('CLOCK_UNCERTAIN', () => state.member.authorizeLocal(state.spaceId, 'read'));
    state.member.resume(true);
    assert.equal(state.member.clockEpochValid, true);
    assert.equal(state.member.getSpace(state.spaceId).syncState, 'STALE');
    expectCode('EXPIRED', () => state.member.authorizeLocal(state.spaceId, 'read'));
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});

test('nonfinite and unsafe clock values fail closed without producing usable views', async () => {
  const nanState = await setup();
  try {
    nanState.ownerInvalidations.length = 0;
    nanState.ownerClock.wall = Number.NaN;
    expectCode('CLOCK_UNCERTAIN', () => nanState.owner.authorizeLocal(nanState.spaceId, 'read'));
    assert.equal(nanState.owner.clockEpochValid, false);
    assert.equal(nanState.owner.getSpace(nanState.spaceId).syncState, 'STALE');
    assert.ok(nanState.ownerInvalidations.some((value) => value.endsWith(':stale')));
  } finally { nanState.ownerStore.close(); nanState.memberStore.close(); }

  const infiniteState = await setup();
  try {
    infiniteState.memberClock.mono = Number.POSITIVE_INFINITY;
    expectCode('CLOCK_UNCERTAIN', () => infiniteState.member.beginSync(infiniteState.spaceId));
    assert.equal(infiniteState.member.clockEpochValid, false);
    infiniteState.memberClock.mono = Number.MAX_SAFE_INTEGER + 1;
    expectCode('CLOCK_UNCERTAIN', () => infiniteState.member.resume(true));
    assert.equal(infiniteState.member.clockEpochValid, false);
  } finally { infiniteState.ownerStore.close(); infiniteState.memberStore.close(); }
});

test('stored namespace capacity is bounded to the public state-view limit', async () => {
  const state = await setup();
  try {
    const capabilities = ['search', 'read', 'share', 'receive', 'manage'] as const;
    for (let index = 1; index < 32; index += 1) {
      state.owner.createSpace({ capabilities: [...capabilities], localActions: [...capabilities] });
    }
    assert.equal(state.owner.listSpaces().length, 32);
    expectCode('CAPACITY_EXCEEDED', () => state.owner.createSpace({ capabilities: [...capabilities], localActions: [...capabilities] }));
  } finally { state.ownerStore.close(); state.memberStore.close(); }
});
