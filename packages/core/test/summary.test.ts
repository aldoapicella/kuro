import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationDigest } from '@kuro/contracts';
import { makeWorld,ok } from './world.js';

async function delivered(w:Awaited<ReturnType<typeof makeWorld>>,allow:boolean){
  await w.importDoc('Outstanding observations: payment has not been approved.');let view=await w.review();
  if(allow)view=ok(await w.owner.core.app.reviseDraft({draftId:view.draftId,expectedRevision:view.revision,reviewedViewDigest:view.viewDigest,selectedSpanIds:view.selectedSpanIds,conditions:{...view.conditions,allowLocalSummary:true}}));
  const approved=ok(await w.owner.core.app.approveDraft({draftId:view.draftId,expectedRevision:view.revision,reviewedViewDigest:view.viewDigest}));await w.pump();return approved.responseId;
}
test('missing permission to process delivered evidence blocks preparation and generation',async()=>{
  const w=await makeWorld();try{
    const responseId=await delivered(w,false);const result=await w.requester.core.app.requestLocalSummary({responseId});
    assert.deepEqual(result,{ok:false,error:{code:'ACCESS_DENIED',retryable:false}});assert.equal(w.requester.ai.calls.length,0);
  }finally{await w.close();}
});
test('rehashed hidden context is rejected before manifest persistence or execution',async()=>{
  const w=await makeWorld();try{
    const responseId=await delivered(w,true);const original=w.requester.ai.prepareSummary.bind(w.requester.ai);
    w.requester.ai.prepareSummary=async input=>{const p=await original(input);const {digest:_digest,...body}=p;const bad={...body,context:p.context+'UNAUTHORIZED_EXTRA_HISTORY'};return {...bad,digest:preparationDigest(bad)};};
    const summary=ok(await w.requester.core.app.requestLocalSummary({responseId}));await w.pump();
    const row=w.inspect('requester','SELECT * FROM summaries')[0]!;assert.equal(row.state,'FAILED');assert.equal(row.preparation_json,null);
    assert.equal(w.requester.ai.calls.some(c=>c.method==='runPreparedSummary'),false);assert.equal(ok(await w.requester.core.app.getSummary({summaryId:summary.summaryId})).claims.length,0);
  }finally{await w.close();}
});
test('late summary output after policy revocation is discarded with its full manifest retained',async()=>{
  const w=await makeWorld();let release:(()=>void)|undefined;
  try{
    const responseId=await delivered(w,true);const original=w.requester.ai.runPreparedSummary.bind(w.requester.ai);
    w.requester.ai.runPreparedSummary=async input=>{const result=await original(input);await new Promise<void>(resolve=>{release=resolve;});return result;};
    ok(await w.requester.core.app.requestLocalSummary({responseId}));await w.requester.core.tick();await new Promise(resolve=>setImmediate(resolve));assert.ok(release);
    const state=ok(await w.requester.core.app.getState({})).spaces[0]!;
    ok(await w.requester.core.app.setLocalPolicy({spaceId:w.spaceId,memberId:w.owner.memberId,admitted:false,actions:[],validUntilMs:null,expectedRevision:state.policyEpoch}));
    release();await w.requester.core.settled();const row=w.inspect('requester','SELECT * FROM summaries')[0]!;
    assert.equal(row.state,'CANCELLED');assert.equal(row.result_json,null);assert.equal(typeof row.preparation_json,'string');
  }finally{release?.();await w.close();}
});
test('manifest commit failure rolls back the preparation and never invokes generation',async()=>{
  const w=await makeWorld();try{
    const responseId=await delivered(w,true);w.requester.faults.point='before_manifest_commit';
    ok(await w.requester.core.app.requestLocalSummary({responseId}));await w.pump();
    const row=w.inspect('requester','SELECT * FROM summaries')[0]!;
    assert.equal(row.state,'FAILED');assert.equal(row.preparation_json,null);assert.equal(row.result_json,null);
    assert.equal(w.requester.ai.calls.some(c=>c.method==='runPreparedSummary'),false);
    assert.equal(ok(await w.requester.core.app.getEvidence({responseId})).passages.length,1);
  }finally{await w.close();}
});
test('suspend during preparation discards the manifest and cannot start generation after resume',async()=>{
  const w=await makeWorld();let release:(()=>void)|undefined;
  try{
    const responseId=await delivered(w,true);const original=w.requester.ai.prepareSummary.bind(w.requester.ai);
    w.requester.ai.prepareSummary=async input=>{const prepared=await original(input);await new Promise<void>(resolve=>{release=resolve;});return prepared;};
    ok(await w.requester.core.app.requestLocalSummary({responseId}));await w.requester.core.tick();await new Promise(resolve=>setImmediate(resolve));assert.ok(release);
    w.requester.core.suspend();await w.requester.core.resume(true);release();await w.requester.core.settled();
    const row=w.inspect('requester','SELECT * FROM summaries')[0]!;
    assert.equal(row.state,'CANCELLED');assert.equal(row.preparation_json,null);assert.equal(row.result_json,null);
    assert.equal(w.requester.ai.calls.some(c=>c.method==='runPreparedSummary'),false);
  }finally{release?.();await w.close();}
});
