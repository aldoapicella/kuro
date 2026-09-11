import test from 'node:test';
import assert from 'node:assert/strict';
import { KuroError, encodeWire, decodeWire } from '@kuro/contracts';
import type { SpaceView } from '@kuro/contracts';
import { MemoryTransport } from '@kuro/transport';
import { Store } from '../src/store.js';
import { WORKFLOW_SCHEMA } from '../src/schema.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeAiPort, FakeClock, FakeIds } from '../src/testing.js';
import { ALL,makeWorld,ok } from './world.js';

test('durable round-robin identity fairness yields index batches and enforces queue capacity',async()=>{
  const store=new Store(':memory:');store.migrate(2,WORKFLOW_SCHEMA);const clock=new FakeClock();const ids=new FakeIds('scheduler');const ai=new FakeAiPort();
  const space:SpaceView={spaceId:'1'.repeat(32),authorityKey:'a'.repeat(64),isOwner:true,policyRevision:1,policyEpoch:1,corpusRevision:1,indexGeneration:0,syncState:'CURRENT',lastSyncMs:null,remainingValidityMs:900000};
  const seen:string[]=[];let batches=0;
  const scheduler=new Scheduler(store,clock,ids,ai,async job=>{seen.push(job.identity_id);clock.advance(10);return job.kind==='INDEX'&&batches++<2;},()=>{});
  try{
    store.transaction(()=>{scheduler.enqueue('INDEX',space,'1'.repeat(32),{});scheduler.enqueue('SEARCH',space,'2'.repeat(32),{});scheduler.enqueue('SEARCH',space,'3'.repeat(32),{});scheduler.enqueue('SEARCH',space,'4'.repeat(32),{});scheduler.enqueue('SEARCH',space,'5'.repeat(32),{});});
    assert.throws(()=>store.transaction(()=>scheduler.enqueue('SEARCH',space,'6'.repeat(32),{})),error=>error instanceof KuroError&&error.code==='CAPACITY_EXCEEDED');
    for(let i=0;i<7;i++){scheduler.startNext();await scheduler.settled();}
    assert.deepEqual(seen.slice(0,5),['1','2','3','4','5'].map(v=>v.repeat(32)));
    assert.equal(seen.filter(v=>v==='1'.repeat(32)).length,3);
    assert.equal(store.get<{value:string}>("SELECT value FROM core_meta WHERE key='scheduler_last_identity'")?.value,'1'.repeat(32));
    assert.equal(store.get<{n:number}>("SELECT count(*) n FROM jobs WHERE state='COMPLETE'")?.n,5);
  }finally{await scheduler.stop();store.close();}
});

test('linked device keys aggregate the pending-request quota by authenticated member identity',async()=>{
  const w=await makeWorld();let alternate:MemoryTransport|undefined;
  try{
    const key='d'.repeat(64),alias='e'.repeat(32);
    const current=ok(await w.owner.core.app.getState({})).spaces.find(s=>s.spaceId===w.spaceId)!;
    const token=w.owner.pairing.verify({kind:'member',spaceId:w.spaceId,memberId:w.requester.memberId,peerKey:key,spaceAlias:alias});
    ok(await w.owner.core.app.enrollMember({spaceId:w.spaceId,selectionId:token,capabilities:ALL,validUntilMs:null,expectedRevision:current.policyRevision}));
    w.owner.transport.inner.pair(key);alternate=new MemoryTransport({network:w.network,publicKey:key,pairedPeers:[w.owner.key]});await alternate.start();
    w.advance(6000);ok(await w.requester.core.app.refreshSpace({spaceId:w.spaceId}));await w.pump();await w.importDoc('Outstanding observations pending.');await w.review();
    const received:string[]=[];alternate.subscribe(event=>{if(event.type==='message')received.push(decodeWire(event.bytes).type);});
    await alternate.send(w.owner.key,encodeWire({v:1,type:'SEARCH_REQUEST',requestId:'f'.repeat(32),spaceAlias:alias,audienceKey:w.owner.key,ttlSeconds:3600,query:'Another question'}));await w.pump();
    assert.deepEqual(received,['CLOSED']);assert.equal(w.inspect('owner',"SELECT count(*) n FROM requests WHERE direction='IN'")[0]!.n,1);
  }finally{await alternate?.stop();await w.close();}
});

test('an undelivered approval still occupies its identity quota until ACK',async()=>{
  const w=await makeWorld();
  try{
    await w.importDoc('Outstanding observations remain pending.');
    const view=await w.review();
    ok(await w.owner.core.app.approveDraft({draftId:view.draftId,expectedRevision:view.revision,reviewedViewDigest:view.viewDigest}));
    const second=encodeWire({v:1,type:'SEARCH_REQUEST',requestId:'f'.repeat(32),spaceAlias:w.alias,audienceKey:w.owner.key,ttlSeconds:3600,query:'Second question'});
    await w.requester.transport.inner.send(w.owner.key,second);w.network.flush();await w.owner.core.settled();
    assert.equal(w.inspect('owner','SELECT count(*) n FROM requests')[0]!.n,1);
    assert.equal(w.inspect('owner','SELECT state FROM outbox')[0]!.state,'OUTBOX_READY');
    assert.ok(w.owner.transport.sent.some(frame=>{const message=decodeWire(frame.bytes);return message.type==='CLOSED'&&message.requestId==='f'.repeat(32);}));
    await w.pump();
    const third=encodeWire({v:1,type:'SEARCH_REQUEST',requestId:'e'.repeat(32),spaceAlias:w.alias,audienceKey:w.owner.key,ttlSeconds:3600,query:'Third question'});
    await w.requester.transport.inner.send(w.owner.key,third);w.network.flush();await w.owner.core.settled();
    assert.equal(w.inspect('owner','SELECT count(*) n FROM requests')[0]!.n,2);
    assert.equal(w.inspect('owner','SELECT state FROM outbox')[0]!.state,'ACKED');
  }finally{await w.close();}
});
