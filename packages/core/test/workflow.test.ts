import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWire, encodeWire } from '@kuro/contracts';
import type { ReviewView } from '@kuro/contracts';
import { MemoryTransport } from '@kuro/transport';
import { ALL,makeWorld,ok } from './world.js';

const approve=(view:ReviewView)=>({draftId:view.draftId,expectedRevision:view.revision,reviewedViewDigest:view.viewDigest});
test('two persistent cores filter restricted/cross-space sources before ranking and deliver only the approved view',async()=>{
  const w=await makeWorld();try{
    const allowed=await w.importDoc('KURO provisional acceptance has outstanding observations. Café 🌍\r\n');
    const restricted=await w.importDoc('RESTRICTED_SENTINEL outstanding observations with private details.',true);
    const other=ok(await w.owner.core.app.createSpace({capabilities:ALL,localActions:ALL}));await w.importDoc('CROSS_SPACE_SENTINEL outstanding observations.',true,other.spaceId);
    w.owner.ai.calls.length=0;
    let view=await w.review();assert.equal(view.passages.length,1);assert.equal(view.passages[0]!.ref.documentId,allowed.documentId);
    assert.equal(JSON.stringify(view).includes('SENTINEL'),false);
    assert.ok(w.owner.ai.calls.some(c=>c.method==='rankAllowed'));
    const forbiddenSpan=w.inspect('owner',`SELECT span_id FROM spans WHERE document_id='${restricted.documentId}'`)[0]!.span_id;
    assert.equal(JSON.stringify(w.owner.ai.calls).includes(String(forbiddenSpan)),false);
    view=ok(await w.owner.core.app.reviseDraft({...approve(view),selectedSpanIds:view.selectedSpanIds,conditions:{...view.conditions,allowLocalSummary:true}}));
    const sent=ok(await w.owner.core.app.approveDraft(approve(view)));await w.pump();
    const evidence=ok(await w.requester.core.app.getEvidence({responseId:sent.responseId}));assert.deepEqual(evidence.passages,view.passages);
    assert.equal(w.inspect('owner','SELECT state FROM outbox')[0]!.state,'ACKED');
    assert.equal(w.requester.ai.calls.length,0);
    w.requester.ai.available=false;assert.equal((await w.requester.core.app.getEvidence({responseId:sent.responseId})).ok,true);
    assert.deepEqual(await w.requester.core.app.requestLocalSummary({responseId:sent.responseId}),{ok:false,error:{code:'MODEL_UNAVAILABLE',retryable:true}});
    w.requester.ai.available=true;
    const summary=ok(await w.requester.core.app.requestLocalSummary({responseId:sent.responseId}));await w.pump();
    const draft=ok(await w.requester.core.app.getSummary({summaryId:summary.summaryId}));assert.equal(draft.state,'DRAFT');assert.equal(draft.requiresSemanticReview,true);assert.deepEqual(draft.claims[0]!.quotes,view.passages);
    assert.equal(w.inspect('requester','SELECT count(*) n FROM summaries WHERE preparation_json IS NOT NULL')[0]!.n,1);
  }finally{await w.close();}
});

test('approval rollback, concurrent approval and revocation before dispatch preserve the atomic boundary',async()=>{
  const w=await makeWorld();try{
    await w.importDoc('Outstanding observations remain pending.');const view=await w.review();
    w.owner.faults.point='after_approval_insert';const failed=await w.owner.core.app.approveDraft(approve(view));assert.equal(failed.ok,false);
    assert.equal(w.inspect('owner','SELECT count(*) n FROM approvals')[0]!.n,0);assert.equal(w.inspect('owner','SELECT count(*) n FROM outbox')[0]!.n,0);
    w.owner.faults.point='';
    const results=await Promise.all([w.owner.core.app.approveDraft(approve(view)),w.owner.core.app.approveDraft(approve(view))]);assert.equal(results.filter(r=>r.ok).length,1);
    const state=ok(await w.owner.core.app.getState({})).spaces.find(s=>s.spaceId===w.spaceId)!;
    ok(await w.owner.core.app.setLocalPolicy({spaceId:w.spaceId,memberId:w.requester.memberId,admitted:false,actions:[],validUntilMs:null,expectedRevision:state.policyEpoch}));
    await w.pump();assert.equal(w.inspect('requester','SELECT count(*) n FROM inbox')[0]!.n,0);assert.equal(w.inspect('owner','SELECT state FROM outbox')[0]!.state,'CANCELLED');
  }finally{await w.close();}
});

test('lost ACK and receiver restart retry immutable bytes with one inbox effect; changed replay fails',async()=>{
  const w=await makeWorld();try{
    await w.importDoc('Outstanding observations: payment has not been approved.');const view=await w.review();
    w.requester.transport.dropAck=true;const approval=ok(await w.owner.core.app.approveDraft(approve(view)));await w.pump();
    const original=w.owner.transport.sent.find(s=>decodeWire(s.bytes).type==='APPROVED_RESPONSE')!.bytes;
    assert.equal(w.inspect('requester','SELECT count(*) n FROM inbox')[0]!.n,1);
    await w.restart('requester');w.requester.transport.dropAck=false;w.advance(3000);await w.pump();
    const copies=w.owner.transport.sent.filter(s=>decodeWire(s.bytes).type==='APPROVED_RESPONSE');assert.ok(copies.length>=2);for(const copy of copies)assert.deepEqual(copy.bytes,original);
    assert.equal(w.inspect('requester','SELECT count(*) n FROM inbox')[0]!.n,1);assert.equal(w.inspect('owner','SELECT state FROM outbox')[0]!.state,'ACKED');
    const message=decodeWire(original);assert.equal(message.type,'APPROVED_RESPONSE');if(message.type!=='APPROVED_RESPONSE')throw new Error();
    const altered={...message,conditions:{...message.conditions,validForSeconds:10}};
    const acks=w.requester.transport.sent.filter(s=>decodeWire(s.bytes).type==='RESPONSE_ACK').length;
    await w.owner.transport.send(w.requester.key,encodeWire(altered));w.network.flush();await w.requester.core.settled();
    assert.equal(w.requester.transport.sent.filter(s=>decodeWire(s.bytes).type==='RESPONSE_ACK').length,acks);
    assert.equal(w.inspect('requester','SELECT response_id FROM inbox')[0]!.response_id,approval.responseId);
  }finally{await w.close();}
});

test('ACK from another authenticated paired peer cannot acknowledge an approval',async()=>{
  const w=await makeWorld();let alternate:MemoryTransport|undefined;
  try{
    await w.importDoc('Outstanding observations remain.');const view=await w.review();w.requester.transport.dropAck=true;
    ok(await w.owner.core.app.approveDraft(approve(view)));await w.pump();
    const bytes=w.requester.transport.sent.find(s=>decodeWire(s.bytes).type==='RESPONSE_ACK')!.bytes;
    const other='d'.repeat(64);w.owner.transport.inner.pair(other);alternate=new MemoryTransport({network:w.network,publicKey:other,pairedPeers:[w.owner.key]});await alternate.start();
    await alternate.send(w.owner.key,bytes);await w.pump();assert.notEqual(w.inspect('owner','SELECT state FROM outbox')[0]!.state,'ACKED');
    await w.requester.transport.inner.send(w.owner.key,bytes);await w.pump();assert.equal(w.inspect('owner','SELECT state FROM outbox')[0]!.state,'ACKED');
  }finally{await alternate?.stop();await w.close();}
});

test('admission rollback emits no RECEIVED and an exact outgoing retry retains the original TTL',async()=>{
  const w=await makeWorld();try{
    await w.importDoc('Outstanding observations remain.');w.owner.faults.point='before_received_commit';
    ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Outstanding observations?',ttlSeconds:3600}));await w.pump();
    assert.equal(w.inspect('owner','SELECT count(*) n FROM requests')[0]!.n,0);assert.equal(w.owner.transport.sent.some(s=>decodeWire(s.bytes).type==='RECEIVED'),false);
    const expiry=w.inspect('requester','SELECT expires_wall FROM requests')[0]!.expires_wall;
    w.owner.faults.point='';w.advance(3000);await w.pump();
    assert.equal(w.inspect('owner','SELECT count(*) n FROM requests')[0]!.n,1);assert.equal(w.inspect('requester','SELECT expires_wall FROM requests')[0]!.expires_wall,expiry);
    const original=w.requester.transport.sent.find(s=>decodeWire(s.bytes).type==='SEARCH_REQUEST')!;
    const message=decodeWire(original.bytes);if(message.type!=='SEARCH_REQUEST')throw new Error();
    await w.requester.transport.send(w.owner.key,encodeWire({...message,ttlSeconds:7200}));await w.pump();
    assert.equal(w.inspect('owner','SELECT count(*) n FROM requests')[0]!.n,1);
  }finally{await w.close();}
});

test('storage failure before receipt emits no ACK and permits exact retry',async()=>{
  const w=await makeWorld();try{
    await w.importDoc('Outstanding observations pending.');const view=await w.review();w.requester.faults.point='before_receipt_commit';
    ok(await w.owner.core.app.approveDraft(approve(view)));await w.pump();
    assert.equal(w.inspect('requester','SELECT count(*) n FROM inbox')[0]!.n,0);assert.equal(w.requester.transport.sent.some(s=>decodeWire(s.bytes).type==='RESPONSE_ACK'),false);
    w.requester.faults.point='';w.advance(3000);await w.pump();assert.equal(w.inspect('requester','SELECT count(*) n FROM inbox')[0]!.n,1);
  }finally{await w.close();}
});
