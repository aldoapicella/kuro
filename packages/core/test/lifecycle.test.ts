import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWire, encodeWire } from '@kuro/contracts';
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

test('local policy cancellation ends an unsent question before dispatch and releases its identity quota',async()=>{
  const w=await makeWorld();try{
    const request=ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Outstanding observations?',ttlSeconds:3600}));
    const space=ok(await w.requester.core.app.getState({})).spaces[0]!;
    const denied=ok(await w.requester.core.app.setLocalPolicy({spaceId:w.spaceId,memberId:w.owner.memberId,admitted:false,actions:[],validUntilMs:null,expectedRevision:space.policyEpoch}));
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'CANCELLED');
    ok(await w.requester.core.app.setLocalPolicy({spaceId:w.spaceId,memberId:w.owner.memberId,admitted:true,actions:ALL,validUntilMs:null,expectedRevision:denied.policyEpoch}));
    await w.pump();
    assert.equal(w.requester.transport.sent.some(frame=>decodeWire(frame.bytes).type==='SEARCH_REQUEST'),false);
    const fresh=ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Fresh question?',ttlSeconds:3600}));
    assert.notEqual(fresh.requestId,request.requestId);
  }finally{await w.close();}
});

test('a policy expiry during outgoing authorization cannot dispatch the request it just cancelled',async()=>{
  const w=await makeWorld();try{
    const deadline=w.requester.clock.wallNowMs()+1000;
    ok(await w.requester.core.app.importText({spaceId:w.spaceId,selectionId:w.requester.files.add('Unrelated local snapshot with expiring recipient access.'),replaceDocumentId:null,expectedRevision:null,rules:[
      {memberId:w.requester.memberId,actions:ALL,validUntilMs:null},
      {memberId:w.owner.memberId,actions:['receive'],validUntilMs:deadline},
    ]}));await w.pump();
    ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Outstanding observations?',ttlSeconds:3600}));
    w.advance(999);
    const session=w.requester.options.sessions;const current=session.current.bind(session);let crossed=false;
    // The trusted session provider runs during send authorization. Time can cross a
    // scheduled ACL boundary here after tick has selected the still-pending request.
    session.current=()=>{if(!crossed){crossed=true;w.requester.clock.advance(1);}return current();};
    await w.requester.core.tick();
    assert.equal(crossed,true);
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'CANCELLED');
    assert.equal(w.inspect('requester','SELECT attempts FROM requests')[0]!.attempts,0);
    assert.equal(w.requester.transport.sent.some(frame=>decodeWire(frame.bytes).type==='SEARCH_REQUEST'),false);
  }finally{await w.close();}
});

test('a policy expiry during receipt authorization cannot revive the request or acknowledge new evidence',async()=>{
  const w=await makeWorld();try{
    const deadline=w.requester.clock.wallNowMs()+1000;
    ok(await w.requester.core.app.importText({spaceId:w.spaceId,selectionId:w.requester.files.add('Unrelated local snapshot with expiring recipient access.'),replaceDocumentId:null,expectedRevision:null,rules:[
      {memberId:w.requester.memberId,actions:ALL,validUntilMs:null},
      {memberId:w.owner.memberId,actions:['receive'],validUntilMs:deadline},
    ]}));await w.pump();
    await w.importDoc('Outstanding observations awaiting approved delivery.');const view=await w.review();
    ok(await w.owner.core.app.approveDraft({draftId:view.draftId,expectedRevision:view.revision,reviewedViewDigest:view.viewDigest}));
    const approvedBytes=Uint8Array.from(w.inspect('owner','SELECT bytes FROM approvals')[0]!.bytes as Uint8Array);
    w.advance(999);
    const session=w.requester.options.sessions;const current=session.current.bind(session);let crossed=false;
    session.current=()=>{if(!crossed){crossed=true;w.requester.clock.advance(1);}return current();};
    await w.owner.transport.send(w.requester.key,approvedBytes);w.network.flush();await w.requester.core.settled();
    assert.equal(crossed,true);
    assert.equal(w.inspect('requester','SELECT count(*) n FROM inbox')[0]!.n,0);
    assert.equal(w.requester.transport.sent.some(frame=>decodeWire(frame.bytes).type==='RESPONSE_ACK'),false);
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'CANCELLED','cancellation must commit without needing another tick');
  }finally{await w.close();}
});

test('denial cancels a received request; regrant and late correlated packets cannot revive it',async()=>{
  const w=await makeWorld();try{
    await w.importDoc('Outstanding observations awaiting local approval.');const view=await w.review();
    ok(await w.owner.core.app.approveDraft({draftId:view.draftId,expectedRevision:view.revision,reviewedViewDigest:view.viewDigest}));
    const approvedBytes=Uint8Array.from(w.inspect('owner','SELECT bytes FROM approvals')[0]!.bytes as Uint8Array);
    const space=ok(await w.owner.core.app.getState({})).spaces[0]!;
    const denied=ok(await w.owner.core.app.setMember({spaceId:w.spaceId,memberId:w.requester.memberId,active:false,capabilities:[],validUntilMs:null,expectedRevision:space.policyRevision}));
    w.advance(6000);ok(await w.requester.core.app.refreshSpace({spaceId:w.spaceId}));w.advance(1000);await w.pump();
    assert.equal(ok(await w.requester.core.app.getState({})).spaces[0]!.syncState,'DENIED');
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'CANCELLED');
    ok(await w.owner.core.app.setMember({spaceId:w.spaceId,memberId:w.requester.memberId,active:true,capabilities:ALL,validUntilMs:null,expectedRevision:denied.policyRevision}));
    w.advance(6000);ok(await w.requester.core.app.refreshSpace({spaceId:w.spaceId}));w.advance(1000);await w.pump();
    assert.equal(ok(await w.requester.core.app.getState({})).spaces[0]!.syncState,'CURRENT');
    for(const type of ['RECEIVED','CLOSED'] as const)await w.owner.transport.send(w.requester.key,encodeWire({v:1,type,requestId:view.requestId,spaceAlias:w.alias}));
    await w.owner.transport.send(w.requester.key,approvedBytes);await w.pump();
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'CANCELLED');
    assert.equal(w.inspect('requester','SELECT count(*) n FROM inbox')[0]!.n,0);
    assert.equal(w.requester.transport.sent.some(frame=>decodeWire(frame.bytes).type==='RESPONSE_ACK'),false);
    const fresh=await w.review();assert.notEqual(fresh.requestId,view.requestId);
  }finally{await w.close();}
});

test('unchanged-policy restart retries the original outgoing question within its original TTL',async()=>{
  const w=await makeWorld();try{
    await w.importDoc('Outstanding observations survive connection loss.');
    w.network.setFaults({disconnect:true});
    const request=ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Outstanding observations?',ttlSeconds:3600}));
    await w.requester.core.tick();
    const before=w.inspect('requester','SELECT bytes,expires_wall,expires_mono FROM requests')[0]!;
    w.advance(6000);await w.restart('requester');
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'OUTGOING');
    w.network.setFaults({disconnect:false});ok(await w.requester.core.app.refreshSpace({spaceId:w.spaceId}));w.advance(1000);await w.pump();
    const after=w.inspect('requester','SELECT bytes,expires_wall,expires_mono,state FROM requests')[0]!;
    assert.equal(after.state,'RECEIVED');assert.deepEqual(after.bytes,before.bytes);
    assert.equal(after.expires_wall,before.expires_wall);assert.equal(after.expires_mono,before.expires_mono);
    assert.equal(ok(await w.owner.core.app.listReviews({spaceId:w.spaceId}))[0]!.requestId,request.requestId);
    const frames=w.requester.transport.sent.filter(frame=>decodeWire(frame.bytes).type==='SEARCH_REQUEST');
    assert.ok(frames.length>=2);assert.deepEqual(frames[0]!.bytes,frames.at(-1)!.bytes);
  }finally{await w.close();}
});

test('an outgoing request cancelled at its authority lease boundary stays cancelled after unchanged renewal',async()=>{
  const w=await makeWorld();try{
    w.network.setFaults({disconnect:true});
    const request=ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Outstanding observations?',ttlSeconds:3600}));
    w.advance(899999);await w.requester.core.tick();
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'OUTGOING');
    w.advance(1);await w.requester.core.tick();
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'CANCELLED');
    const sends=w.requester.transport.sent.filter(frame=>decodeWire(frame.bytes).type==='SEARCH_REQUEST').length;
    w.network.setFaults({disconnect:false});w.advance(11000);
    ok(await w.requester.core.app.refreshSpace({spaceId:w.spaceId}));w.advance(1000);await w.pump();
    assert.equal(ok(await w.requester.core.app.getState({})).spaces[0]!.syncState,'CURRENT');
    assert.equal(w.inspect('requester','SELECT state FROM requests')[0]!.state,'CANCELLED');
    assert.equal(w.requester.transport.sent.filter(frame=>decodeWire(frame.bytes).type==='SEARCH_REQUEST').length,sends);
    const fresh=ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Fresh question?',ttlSeconds:3600}));
    assert.notEqual(fresh.requestId,request.requestId);
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

test('request expiry cancels native work and records an expired job',async()=>{
  const w=await makeWorld();let release:(()=>void)|undefined;
  try{
    await w.importDoc('Outstanding observations pending.');
    w.owner.ai.beforeOperation=async(method)=>{if(method==='embedBlocks')await new Promise<void>(resolve=>{release=resolve;});};
    ok(await w.requester.core.app.submitQuestion({spaceId:w.spaceId,custodianKey:w.owner.key,query:'Outstanding?',ttlSeconds:1}));
    await w.requester.core.tick();w.network.flush();await w.owner.core.tick();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(w.inspect('owner',"SELECT count(*) n FROM jobs WHERE state='RUNNING'")[0]!.n,1);
    const jobId=w.inspect('owner',"SELECT job_id FROM jobs WHERE state='RUNNING'")[0]!.job_id;
    const cancel=w.owner.ai.cancel.bind(w.owner.ai);let committedAtCancel=false;
    w.owner.ai.cancel=async id=>{
      assert.equal(id,jobId);
      // A separate connection must see the committed expiry before entering the adapter.
      const persisted=w.inspect('owner','SELECT state,error_code FROM jobs ORDER BY sequence').at(-1)!;
      committedAtCancel=persisted.state==='EXPIRED'&&persisted.error_code==='EXPIRED';
      await cancel(id);
    };
    w.advance(1001);await w.owner.core.tick();
    const expired=w.inspect('owner','SELECT state,error_code FROM jobs ORDER BY sequence').at(-1)!;
    assert.equal(expired.state,'EXPIRED');assert.equal(expired.error_code,'EXPIRED');
    assert.equal(committedAtCancel,true);
    assert.ok(w.owner.ai.calls.some(call=>call.method==='cancel'&&(call.input as {jobId:string}).jobId===jobId));
    release?.();await w.owner.core.settled();await w.pump();
    assert.equal(w.inspect('owner','SELECT count(*) n FROM reviews')[0]!.n,0);
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
