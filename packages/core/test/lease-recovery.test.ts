import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWire } from '@kuro/contracts';
import { makeWorld,ok } from './world.js';

test('a stale restart expires an outgoing request at the persisted lease deadline before unchanged renewal',async()=>{
  const w=await makeWorld();try{
    w.network.setFaults({disconnect:true});
    const request=ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Outstanding observations?',ttlSeconds:3600}));
    await w.requester.core.tick();
    const lease=w.inspect('requester','SELECT wall_deadline_ms FROM authority_spaces')[0]!.wall_deadline_ms as number;
    w.advance(6000);await w.restart('requester');
    // A process may restart its monotonic clock at any value. Stale lease recovery
    // therefore uses the persisted wall deadline rather than the old monotonic one.
    w.requester.clock.mono=0;
    w.advance(lease-w.requester.clock.wall-1);
    await w.requester.core.tick();
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'OUTGOING');
    w.advance(1);await w.requester.core.tick();
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'CANCELLED');
    assert.equal(w.inspect('requester','SELECT sync_state FROM authority_spaces')[0]!.sync_state,'EXPIRED');
    const epoch=w.inspect('requester','SELECT policy_epoch FROM authority_spaces')[0]!.policy_epoch;
    const sends=w.requester.transport.sent.filter(frame=>decodeWire(frame.bytes).type==='SEARCH_REQUEST').length;

    // Repeated disconnected ticks must not invalidate the same expired lease again.
    w.advance(11000);await w.requester.core.tick();
    assert.equal(w.inspect('requester','SELECT policy_epoch FROM authority_spaces')[0]!.policy_epoch,epoch);
    w.network.setFaults({disconnect:false});
    ok(await w.requester.core.app.refreshSpace({spaceId:w.spaceId}));w.advance(1000);await w.pump();
    assert.equal(ok(await w.requester.core.app.getState({})).spaces[0]!.syncState,'CURRENT');
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'CANCELLED');
    assert.equal(w.requester.transport.sent.filter(frame=>decodeWire(frame.bytes).type==='SEARCH_REQUEST').length,sends);
    assert.equal(w.inspect('owner','SELECT count(*) n FROM reviews')[0]!.n,0);
    const fresh=ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Fresh question?',ttlSeconds:3600}));
    assert.notEqual(fresh.requestId,request.requestId);
  }finally{await w.close();}
});
