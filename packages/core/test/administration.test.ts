import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, ok } from './world.js';

test('administration separates owner state, recipient projection, and editable local grants', async () => {
  const w = await makeWorld();
  try {
    const document = await w.importDoc('Administration test source.');
    const owner = ok(await w.owner.core.app.getSpaceAdministration({ spaceId: w.spaceId }));
    assert.equal(owner.scope, 'owner');
    assert.equal(owner.tombstoned, false);
    assert.equal(owner.members.length, 2);
    assert.equal(owner.relationships.length, 1);
    assert.equal(owner.members.some(member => member.devices.some(device => 'spaceAlias' in device)), true);

    const participant = ok(await w.requester.core.app.getSpaceAdministration({ spaceId: w.spaceId }));
    assert.equal(participant.scope, 'recipient-projection');
    assert.equal('relationships' in participant, false);
    assert.equal('tombstoned' in participant, false);
    assert.deepEqual(participant.members.map(member => Object.keys(member).sort()), [['capabilities', 'deviceKeys', 'memberId'], ['capabilities', 'deviceKeys', 'memberId']]);

    const grants = ok(await w.requester.core.app.getLocalGrants({ spaceId: w.spaceId }));
    assert.equal(grants.canEdit, true);
    assert.equal(grants.policyEpoch, participant.space.policyEpoch);
    const rules = ok(await w.owner.core.app.getDocumentRules({ spaceId: w.spaceId, documentId: document.documentId }));
    assert.equal(rules.revision, document.revision);
    assert.equal(rules.rules.length, 2);
  } finally { await w.close(); }
});

test('revoking one verified device changes shared policy without reviving approvals', async () => {
  const w = await makeWorld();
  try {
    const extraKey = 'c'.repeat(64);
    const selection = w.owner.pairing.verify({ kind: 'member', spaceId: w.spaceId, memberId: w.requester.memberId, peerKey: extraKey, spaceAlias: 'd'.repeat(32) });
    let space = ok(await w.owner.core.app.getState({})).spaces.find(view => view.spaceId === w.spaceId)!;
    ok(await w.owner.core.app.enrollMember({ spaceId: w.spaceId, selectionId: selection, capabilities: ['search', 'read', 'share', 'receive', 'manage'], validUntilMs: null, expectedRevision: space.policyRevision }));
    w.advance(6000); ok(await w.requester.core.app.refreshSpace({ spaceId: w.spaceId })); await w.pump();
    const ownerDocument = await w.importDoc('Device revocation must cancel only future authorization.');
    const ownerRules = ok(await w.owner.core.app.getDocumentRules({ spaceId: w.spaceId, documentId: ownerDocument.documentId }));
    assert.equal(ownerRules.rules.find(rule => rule.memberId === w.requester.memberId)!.actions.length, 1);
    const requesterDocument = ok(await w.requester.core.app.importText({ spaceId: w.spaceId, selectionId: w.requester.files.add('Participant administration must not duplicate linked-device rules.'), replaceDocumentId: null, expectedRevision: null, rules: [{ memberId: w.requester.memberId, actions: ['search', 'read', 'share', 'receive', 'manage'], validUntilMs: null }, { memberId: w.owner.memberId, actions: ['receive'], validUntilMs: null }] }));
    await w.pump();
    const requesterRules = ok(await w.requester.core.app.getDocumentRules({ spaceId: w.spaceId, documentId: requesterDocument.documentId }));
    const linkedActions = requesterRules.rules.find(rule => rule.memberId === w.requester.memberId)!.actions;
    assert.equal(linkedActions.length, 5); assert.equal(new Set(linkedActions).size, 5);
    const review = await w.review();
    ok(await w.owner.core.app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest }));
    space = ok(await w.owner.core.app.getState({})).spaces.find(view => view.spaceId === w.spaceId)!;
    ok(await w.owner.core.app.revokeDevice({ spaceId: w.spaceId, publicKey: extraKey, expectedRevision: space.policyRevision }));
    assert.equal(w.inspect('owner', 'SELECT state FROM outbox')[0]!.state, 'CANCELLED');
    assert.deepEqual(await w.owner.core.app.revokeDevice({ spaceId: w.spaceId, publicKey: extraKey, expectedRevision: space.policyRevision }), { ok: false, error: { code: 'STALE_REVISION', retryable: false } });
    const administration = ok(await w.owner.core.app.getSpaceAdministration({ spaceId: w.spaceId }));
    if (administration.scope !== 'owner') throw new Error('unreachable');
    assert.equal(administration.members.find(member => member.memberId === w.requester.memberId)!.devices.find(device => device.publicKey === extraKey)!.revoked, true);

    w.advance(6000); ok(await w.requester.core.app.refreshSpace({ spaceId: w.spaceId })); await w.pump();
    const projection = ok(await w.requester.core.app.getSpaceAdministration({ spaceId: w.spaceId }));
    if (projection.scope !== 'recipient-projection') throw new Error('unreachable');
    assert.equal(projection.members.find(member => member.memberId === w.requester.memberId)!.deviceKeys.includes(extraKey), false);
    assert.equal(projection.members.find(member => member.memberId === w.requester.memberId)!.deviceKeys.includes(w.requester.key), true);
  } finally { await w.close(); }
});

test('local administration drops inactive and expired grants at their clock boundaries', async () => {
  const w = await makeWorld();
  try {
    const expiresAt = w.requester.clock.wallNowMs() + 1;
    const state = ok(await w.requester.core.app.getState({})).spaces.find(view => view.spaceId === w.spaceId)!;
    ok(await w.requester.core.app.setLocalPolicy({ spaceId: w.spaceId, memberId: w.owner.memberId, admitted: true, actions: ['manage'], validUntilMs: expiresAt, expectedRevision: state.policyEpoch }));
    w.advance(1);
    const expired = ok(await w.requester.core.app.getLocalGrants({ spaceId: w.spaceId })).grants.find(grant => grant.memberId === w.owner.memberId)!;
    assert.equal(expired.admitted, false);

    const ownerState = ok(await w.owner.core.app.getState({})).spaces.find(view => view.spaceId === w.spaceId)!;
    ok(await w.owner.core.app.setMember({ spaceId: w.spaceId, memberId: w.requester.memberId, active: false, capabilities: [], validUntilMs: null, expectedRevision: ownerState.policyRevision }));
    const ownerGrants = ok(await w.owner.core.app.getLocalGrants({ spaceId: w.spaceId }));
    assert.equal(ownerGrants.grants.some(grant => grant.memberId === w.requester.memberId), false);
  } finally { await w.close(); }
});
