import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryTransport } from '@kuro/transport';
import { openCore } from '../src/index.js';
import { FakeSession,FAKE_EMBEDDING_PROFILE } from '../src/testing.js';
import { ALL,RecordingTransport,makeWorld,ok } from './world.js';

test('explicit owner identity recovery copies snapshots and restrictions but never old approvals',async()=>{
  const w=await makeWorld();try{
    const document=await w.importDoc('Outstanding observations with immutable recovery provenance.');const review=await w.review();
    ok(await w.owner.core.app.approveDraft({draftId:review.draftId,expectedRevision:review.revision,reviewedViewDigest:review.viewDigest}));
    const old=ok(await w.owner.core.app.getState({})).spaces.find(s=>s.spaceId===w.spaceId)!;
    await w.owner.core.stop();
    const newKey='e'.repeat(64),newSpace='f'.repeat(32);
    const rotated=new RecordingTransport(new MemoryTransport({network:w.network,publicKey:newKey}));
    const newOptions={...w.owner.options,transport:rotated,sessions:new FakeSession({memberId:w.owner.memberId,deviceKey:newKey,validUntilMs:w.owner.clock.wall+100_000_000})};
    w.owner.core=await openCore(newOptions);
    const selectionId=w.owner.pairing.verify({kind:'authority',spaceId:newSpace,authorityKey:newKey,spaceAlias:'d'.repeat(32)});
    const replacement=ok(await w.owner.core.app.replaceAuthority({oldSpaceId:w.spaceId,selectionId,expectedRevision:old.policyEpoch,capabilities:ALL,localActions:ALL}));
    assert.equal(replacement.spaceId,newSpace);assert.equal(replacement.authorityKey,newKey);
    const documents=w.inspect('owner','SELECT space_id,document_id FROM documents');assert.equal(documents.length,2);assert.ok(documents.every(d=>d.document_id===document.documentId));
    assert.equal(w.inspect('owner','SELECT count(*) n FROM versions')[0]!.n,2);
    assert.equal(w.inspect('owner','SELECT count(*) n FROM approvals')[0]!.n,1);assert.equal(w.inspect('owner','SELECT state FROM outbox')[0]!.state,'CANCELLED');
    assert.equal(w.inspect('owner','SELECT count(*) n FROM authority_spaces WHERE tombstoned=1')[0]!.n,1);
    const oldRows=w.inspect('owner',`SELECT count(*) n FROM document_acl WHERE space_id='${w.spaceId}'`)[0]!.n;
    const newRows=w.inspect('owner',`SELECT count(*) n FROM document_acl WHERE space_id='${newSpace}'`)[0]!.n;assert.equal(newRows,oldRows);
    ok(await w.owner.core.app.setIndexProfile({spaceId:newSpace,profile:FAKE_EMBEDDING_PROFILE,expectedRevision:replacement.corpusRevision}));
    for(let i=0;i<4;i++){await w.owner.core.tick();await w.owner.core.settled();}
    assert.equal(ok(await w.owner.core.app.getState({})).spaces.find(s=>s.spaceId===w.spaceId)!.syncState,'DENIED');
  }finally{await w.close();}
});
