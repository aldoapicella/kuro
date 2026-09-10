import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWire } from '@kuro/contracts';
import { ALL,makeWorld,ok } from './world.js';

test('changed reviewed source cannot be approved and immutable old snapshot remains local',async()=>{
  const w=await makeWorld();try{
    const doc=await w.importDoc('Outstanding observations: original qualification.');const review=await w.review();
    ok(await w.owner.core.app.importText({spaceId:w.spaceId,selectionId:w.owner.files.add('Corrected source with different wording.'),replaceDocumentId:doc.documentId,expectedRevision:doc.revision,rules:w.rules}));
    const result=await w.owner.core.app.approveDraft({draftId:review.draftId,expectedRevision:review.revision,reviewedViewDigest:review.viewDigest});assert.equal(result.ok,false);
    assert.equal(w.inspect('owner','SELECT count(*) n FROM versions')[0]!.n,2);assert.equal(w.inspect('owner','SELECT count(*) n FROM approvals')[0]!.n,0);
  }finally{await w.close();}
});

test('participant custodian dispatch queued across suspend is blocked and fresh sync cannot revive approval',async()=>{
  const w=await makeWorld();try{
    ok(await w.requester.core.app.importText({spaceId:w.spaceId,selectionId:w.requester.files.add('Participant-held outstanding observations.'),replaceDocumentId:null,expectedRevision:null,rules:[{memberId:w.requester.memberId,actions:ALL,validUntilMs:null},{memberId:w.owner.memberId,actions:['receive'],validUntilMs:null}]}));await w.pump();
    ok(await w.owner.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.requester.key,query:'Outstanding observations?',ttlSeconds:3600}));await w.pump();
    const view=ok(await w.requester.core.app.listReviews({spaceId:w.spaceId}))[0]!;assert.ok(view);
    ok(await w.requester.core.app.approveDraft({draftId:view.draftId,expectedRevision:view.revision,reviewedViewDigest:view.viewDigest}));
    w.requester.core.suspend();await w.requester.core.tick();
    assert.equal(w.requester.transport.sent.some(s=>decodeWire(s.bytes).type==='APPROVED_RESPONSE'),false);
    await w.requester.core.resume(true);
    assert.equal(w.inspect('requester','SELECT state FROM outbox')[0]!.state,'CANCELLED');
    w.advance(6000);ok(await w.requester.core.app.refreshSpace({spaceId:w.spaceId}));await w.pump();
    assert.equal(w.inspect('requester','SELECT state FROM outbox')[0]!.state,'CANCELLED');
    assert.equal(w.inspect('owner','SELECT count(*) n FROM inbox')[0]!.n,0);
  }finally{await w.close();}
});

test('authority outage permits cached local operations only until the original lease boundary',async()=>{
  const w=await makeWorld();try{
    await w.importDoc('Outstanding observations remain.');const review=await w.review();
    const approved=ok(await w.owner.core.app.approveDraft({draftId:review.draftId,expectedRevision:review.revision,reviewedViewDigest:review.viewDigest}));await w.pump();
    w.network.setFaults({disconnect:true});w.advance(899999);
    assert.equal((await w.requester.core.app.getEvidence({responseId:approved.responseId})).ok,true);
    w.advance(1);assert.deepEqual(await w.requester.core.app.getEvidence({responseId:approved.responseId}),{ok:false,error:{code:'EXPIRED',retryable:false}});
    assert.equal(w.inspect('requester','SELECT count(*) n FROM inbox')[0]!.n,1);
    assert.equal(ok(await w.requester.core.app.getState({})).spaces[0]!.syncState,'EXPIRED');
  }finally{await w.close();}
});

test('cancellation releases no slot before the native provider settles and late results cannot create review',async()=>{
  const w=await makeWorld();let release:(()=>void)|undefined;
  try{
    await w.importDoc('Outstanding observations pending.');
    w.owner.ai.beforeOperation=async(method)=>{if(method==='embedBlocks')await new Promise<void>(resolve=>{release=resolve;});};
    ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Outstanding observations?',ttlSeconds:3600}));
    await w.requester.core.tick();w.network.flush();await w.owner.core.settled();await w.owner.core.tick();await new Promise(resolve=>setImmediate(resolve));
    assert.ok(release);
    const state=ok(await w.owner.core.app.getState({}));const job=state.jobs.find(j=>j.state==='RUNNING')!;assert.ok(job);
    ok(await w.owner.core.app.cancelJob({jobId:job.jobId}));
    await w.owner.core.tick();assert.equal(w.inspect('owner',"SELECT count(*) n FROM jobs WHERE state='RUNNING'")[0]!.n,0);
    release();await w.owner.core.settled();await w.pump();
    assert.equal(w.inspect('owner','SELECT count(*) n FROM reviews')[0]!.n,0);
    assert.equal(w.inspect('owner',"SELECT state FROM requests WHERE direction='IN'")[0]!.state,'CANCELLED');
  }finally{release?.();await w.close();}
});

test('owner computation begun before suspend cannot publish a late result after trusted resume',async()=>{
  const w=await makeWorld();let release:(()=>void)|undefined;
  try{
    await w.importDoc('Outstanding observations pending.');
    const original=w.owner.ai.embedBlocks.bind(w.owner.ai);
    w.owner.ai.embedBlocks=async input=>{const output=await original(input);await new Promise<void>(resolve=>{release=resolve;});return output;};
    ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Outstanding observations?',ttlSeconds:3600}));
    await w.requester.core.tick();w.network.flush();await w.owner.core.settled();await w.owner.core.tick();await new Promise(resolve=>setImmediate(resolve));
    assert.ok(release);w.owner.core.suspend();await w.owner.core.resume(true);release();await w.owner.core.settled();
    assert.equal(w.inspect('owner','SELECT count(*) n FROM reviews')[0]!.n,0);
    assert.equal(w.inspect('owner',"SELECT state FROM requests WHERE direction='IN'")[0]!.state,'CANCELLED');
  }finally{release?.();await w.close();}
});

test('index excludes unreadable documents explicitly; granting read rebuilds their vectors',async()=>{
  const w=await makeWorld();try{
    const doc=ok(await w.owner.core.app.importText({spaceId:w.spaceId,selectionId:w.owner.files.add('Outstanding observations withheld from operator.'),replaceDocumentId:null,expectedRevision:null,rules:[w.rules[1]!]}));await w.pump();
    assert.equal(w.inspect('owner','SELECT state FROM index_generations')[0]!.state,'COMPLETE');
    assert.equal(w.inspect('owner','SELECT ingestion_state FROM documents')[0]!.ingestion_state,'FAILED');
    ok(await w.owner.core.app.setDocumentRules({spaceId:w.spaceId,documentId:doc.documentId,rules:w.rules,expectedRevision:doc.revision}));
    await w.pump();assert.equal(w.inspect('owner','SELECT count(*) n FROM embeddings')[0]!.n,1);
    assert.equal(w.inspect('owner','SELECT ingestion_state FROM documents')[0]!.ingestion_state,'COMPLETE');
    const view=await w.review();assert.equal(view.passages.length,1);
  }finally{await w.close();}
});
