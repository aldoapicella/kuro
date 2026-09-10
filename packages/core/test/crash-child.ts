import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld,ok } from './world.js';

const mode=process.argv[2]!;const directory=process.argv[3]!;
const w=await makeWorld(directory);
writeFileSync(join(directory,'synthetic-metadata.json'),JSON.stringify({spaceId:w.spaceId,ownerKey:w.owner.key,requesterKey:w.requester.key,ownerId:w.owner.memberId,requesterId:w.requester.memberId}));
const die=()=>{process.kill(process.pid,'SIGKILL');};
if(mode==='index_running'){
  w.owner.ai.beforeOperation=async()=>{die();};
  await w.importDoc('Outstanding observations during indexing.');
}else{
  await w.importDoc('Outstanding observations with durable transaction boundaries.');
  if(mode==='search_running'){
    w.owner.ai.beforeOperation=async()=>{die();};
    await w.review();
  }else{
    const view=await w.review();
    if(mode==='approval_before'){w.owner.faults.point='after_approval_insert';w.owner.faults.onHit=die;}
    if(mode==='approval_after')w.owner.core.app.subscribe(event=>{if(event.entity==='delivery')die();});
    if(mode==='receipt_before'){w.requester.faults.point='before_receipt_commit';w.requester.faults.onHit=die;}
    if(mode==='receipt_after')w.requester.core.app.subscribe(event=>{if(event.entity==='evidence')die();});
    ok(await w.owner.core.app.approveDraft({draftId:view.draftId,expectedRevision:view.revision,reviewedViewDigest:view.viewDigest}));await w.pump();
  }
}
throw new Error('Crash injection did not fire');
