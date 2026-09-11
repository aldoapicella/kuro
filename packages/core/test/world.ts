import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeWire } from '@kuro/contracts';
import type { Capability, Result, TransportPort, TransportEvent } from '@kuro/contracts';
import { MemoryNetwork, MemoryTransport } from '@kuro/transport';
import { openCore } from '../src/index.js';
import { FakeAiPort, FakeClock, FakeIds, FakePairing, FakeSession, MemorySelectedFiles } from '../src/testing.js';
export const ALL:Capability[]=['search','read','share','receive','manage'];
export function ok<T>(result:Result<T>):T{if(!result.ok)throw new Error(result.error.code);return result.value;}
export class RecordingTransport implements TransportPort {
  sent:{peerKey:string;bytes:Uint8Array}[]=[];dropAck=false;
  constructor(readonly inner:MemoryTransport){}
  start(){return this.inner.start();}stop(){return this.inner.stop();}
  async send(peerKey:string,bytes:Uint8Array){this.sent.push({peerKey,bytes:Uint8Array.from(bytes)});if(this.dropAck&&decodeWire(bytes).type==='RESPONSE_ACK')return;await this.inner.send(peerKey,bytes);}
  subscribe(listener:(event:TransportEvent)=>void){return this.inner.subscribe(listener);}
}
export async function makeWorld(existingDirectory?:string){
  const directory=existingDirectory??mkdtempSync(join(tmpdir(),'kuro-core-test-'));const network=new MemoryNetwork();
  const ownerKey='a'.repeat(64),requesterKey='b'.repeat(64);const ownerId='1'.repeat(32),requesterId='2'.repeat(32);
  async function node(label:string,key:string,other:string,memberId:string){
    const ids=new FakeIds(label);const clock=new FakeClock();const ai=new FakeAiPort();const pairing=new FakePairing(ids);const files=new MemorySelectedFiles(ids);
    const session=new FakeSession({memberId,deviceKey:key,validUntilMs:clock.wall+100_000_000});const transport=new RecordingTransport(new MemoryTransport({network,publicKey:key,pairedPeers:[other]}));
    const faults:{point:string;onHit?:()=>void}={point:''};const options={databasePath:join(directory,label+'.sqlite'),ai,transport,clock,ids,sessions:session,selectedFiles:files,pairing,clockInitiallyTrusted:true,testFaultInjector:(point:string)=>{if(faults.point===point){faults.onHit?.();throw new Error('Injected synthetic storage fault');}}};
    return {core:await openCore(options),options,key,memberId,clock,ai,pairing,files,transport,faults};
  }
  const owner=await node('owner',ownerKey,requesterKey,ownerId);const requester=await node('requester',requesterKey,ownerKey,requesterId);
  async function pump(rounds=8){for(let n=0;n<rounds;n++){await owner.core.tick();await requester.core.tick();network.flush();await owner.core.settled();await requester.core.settled();}}
  function advance(ms:number){owner.clock.advance(ms);requester.clock.advance(ms);}
  const initial=ok(await owner.core.app.createSpace({capabilities:ALL,localActions:ALL}));const spaceId=initial.spaceId;const alias='c'.repeat(32);
  const enroll=owner.pairing.verify({kind:'member',spaceId,memberId:requesterId,peerKey:requesterKey,spaceAlias:alias});
  let view=ok(await owner.core.app.enrollMember({spaceId,selectionId:enroll,capabilities:ALL,validUntilMs:null,expectedRevision:initial.policyRevision}));
  view=ok(await owner.core.app.setRelationship({spaceId,memberId:ownerId,otherMemberId:requesterId,allowed:true,validUntilMs:null,expectedRevision:view.policyRevision}));
  const pin=requester.pairing.verify({kind:'authority',spaceId,authorityKey:ownerKey,spaceAlias:alias});
  ok(await requester.core.app.pairSpace({selectionId:pin,localActions:ALL}));
  ok(await requester.core.app.refreshSpace({spaceId}));await pump();
  const rv=ok(await requester.core.app.getState({})).spaces.find(s=>s.spaceId===spaceId)!;
  assert.equal(rv.syncState,'CURRENT');
  ok(await owner.core.app.setLocalPolicy({spaceId,memberId:requesterId,admitted:true,actions:ALL,validUntilMs:null,expectedRevision:view.policyEpoch}));
  ok(await requester.core.app.setLocalPolicy({spaceId,memberId:ownerId,admitted:true,actions:ALL,validUntilMs:null,expectedRevision:rv.policyEpoch}));
  const rules=[{memberId:ownerId,actions:ALL,validUntilMs:null},{memberId:requesterId,actions:['receive'] as Capability[],validUntilMs:null}];
  async function importDoc(text:string,restricted=false,targetSpace=spaceId){const result=ok(await owner.core.app.importText({spaceId:targetSpace,selectionId:owner.files.add(text),replaceDocumentId:null,expectedRevision:null,rules:restricted||targetSpace!==spaceId?[rules[0]!]:rules}));await pump();return result;}
  async function review(){ok(await requester.core.app.submitQuestion({spaceId,custodianKey:ownerKey,query:'Outstanding observations and status?',ttlSeconds:3600}));await pump();const reviews=ok(await owner.core.app.listReviews({spaceId}));assert.equal(reviews.length,1);return reviews[0]!;}
  async function restart(role:'owner'|'requester'){const node=role==='owner'?owner:requester;await node.core.stop();node.core=await openCore(node.options);}
  function inspect(role:'owner'|'requester',sql:string){const db=new DatabaseSync((role==='owner'?owner:requester).options.databasePath,{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}}
  async function close(){await owner.core.stop();await requester.core.stop();rmSync(directory,{recursive:true,force:true});}
  return {directory,network,owner,requester,spaceId,alias,rules,pump,advance,importDoc,review,restart,inspect,close};
}
