import { AppCommands, CORE_LIMITS, KuroError, StateViewSchema, decodeWire, failure, success } from '@kuro/contracts';
import type { AiPort, AppCommandName, AppInput, AppOutputs, AppPort, Clock, CoreLifecyclePort, IdSource, Result, SelectedFilePort, SessionPort, TransportEvent, TransportPort, VerifiedPairingPort } from '@kuro/contracts';
import { Store } from './store.js';
import type { FaultInjector } from './store.js';
import { WORKFLOW_SCHEMA } from './schema.js';
import { Authority } from './authority.js';
import { Scheduler } from './scheduler.js';
import { Retrieval } from './retrieval.js';
import { Delivery } from './delivery.js';
import { Summaries } from './summary.js';
import type { CoreContext } from './context.js';
import type { ApprovalRow, DocumentRow, JobRow, OutboxRow, RequestRow, ReviewRow, SummaryRow } from './rows.js';

export interface CoreOptions {
  databasePath:string; ai:AiPort; transport:TransportPort; clock:Clock; ids:IdSource;
  sessions:SessionPort; selectedFiles:SelectedFilePort; pairing:VerifiedPairingPort;
  clockInitiallyTrusted:boolean;
  /** Explicit fault injection for synthetic harnesses only. */
  testFaultInjector?:FaultInjector;
}

export class CustodyCore implements CoreLifecyclePort {
  readonly app:AppPort;
  readonly #store:Store;
  readonly #authority:Authority;
  readonly #scheduler:Scheduler;
  readonly #retrieval:Retrieval;
  readonly #delivery:Delivery;
  readonly #summaries:Summaries;
  #incoming:Promise<void>=Promise.resolve();
  #inboundCount=0;
  #unsubscribe:(()=>void)|null=null;
  #running=false;
  #ticking=false;
  #lifecycleEpoch=0;

  private constructor(private readonly options:CoreOptions,publicKey:string){
    this.#store=new Store(options.databasePath,options.testFaultInjector);
    try{
    this.#store.migrate(2,WORKFLOW_SCHEMA);
    this.#authority=new Authority(this.#store,{clock:options.clock,ids:options.ids,sessions:options.sessions,pairing:options.pairing,publicKey,invalidate:(space,reason)=>this.invalidate(space,reason),remapNamespace:(oldSpace,newSpace)=>this.remapNamespace(oldSpace,newSpace)});
    this.#scheduler=new Scheduler(this.#store,options.clock,options.ids,options.ai,job=>this.runJob(job),(job,code)=>this.jobFailed(job,code));
    const context:CoreContext={store:this.#store,authority:this.#authority,scheduler:this.#scheduler,ai:options.ai,clock:options.clock,ids:options.ids,files:options.selectedFiles,publicKey,processId:options.ids.nextId(),lifecycleEpoch:()=>this.#lifecycleEpoch,assertEpoch:epoch=>{if(epoch!==this.#lifecycleEpoch||!this.#authority.clockEpochValid)throw new KuroError('CANCELLED');},assertJob:(job,corpus=true)=>{
      this.#scheduler.valid(job);this.#authority.authorizeLocal(job.space_id,job.kind==='SUMMARY'?'receive':'read');
      const space=this.#authority.getSpace(job.space_id);
      if(space.policyEpoch!==job.policy_epoch||(corpus&&space.corpusRevision!==job.corpus_revision)||(job.kind==='SEARCH'&&space.indexGeneration!==job.index_generation))throw new KuroError('STALE_REVISION');
    }};
    this.#retrieval=new Retrieval(context);this.#delivery=new Delivery(context,this.#retrieval);this.#summaries=new Summaries(context,this.#delivery);
    const bind=<K extends AppCommandName>(key:K,fn:(input:AppInput<K>)=>AppOutputs[K]|Promise<AppOutputs[K]>)=>(input:AppInput<K>)=>this.invoke(key,input,fn);
    this.app={
      createSpace:bind('createSpace',i=>this.#authority.createSpace(i)),pairSpace:bind('pairSpace',i=>this.#authority.pairSpace(i)),
      replaceAuthority:bind('replaceAuthority',i=>this.#authority.replaceAuthority(i)),
      enrollMember:bind('enrollMember',i=>this.#authority.enrollMember(i)),setMember:bind('setMember',i=>this.#authority.setMember(i)),
      setRelationship:bind('setRelationship',i=>this.#authority.setRelationship(i)),pairPeer:bind('pairPeer',async i=>{await this.#authority.pairPeer(i);return null;}),
      refreshSpace:bind('refreshSpace',i=>{const sync=this.#authority.beginSync(i.spaceId);return {requestId:sync.requestId};}),
      setLocalPolicy:bind('setLocalPolicy',i=>this.#authority.setLocalPolicy(i)),
      setDocumentRules:bind('setDocumentRules',i=>this.#store.transaction(()=>{
        const document=this.#store.get<DocumentRow>('SELECT * FROM documents WHERE space_id=? AND document_id=?',i.spaceId,i.documentId);
        if(!document||document.revision!==i.expectedRevision)throw new KuroError('STALE_REVISION');
        const result=this.#authority.setDocumentRules(i);
        this.#store.run('UPDATE documents SET revision=revision+1 WHERE space_id=? AND document_id=?',i.spaceId,i.documentId);
        this.#retrieval.reindexAfterPolicyChange(i.spaceId);return result;
      })),
      importText:bind('importText',i=>this.#retrieval.importText(i)),setIndexProfile:bind('setIndexProfile',i=>this.#retrieval.setProfile(i)),
      submitQuestion:bind('submitQuestion',i=>this.#delivery.submit(i)),getState:bind('getState',()=>this.state()),
      listReviews:bind('listReviews',i=>{
        this.#authority.authorizeLocal(i.spaceId,'read');
        return this.#store.all<ReviewRow>("SELECT * FROM reviews WHERE space_id=? AND state='REVIEW'",i.spaceId).map(r=>this.#retrieval.review(r.draft_id));
      }),getReview:bind('getReview',i=>this.#retrieval.review(i.draftId)),reviseDraft:bind('reviseDraft',i=>this.#retrieval.revise(i)),
      approveDraft:bind('approveDraft',i=>this.#delivery.approve(i)),getEvidence:bind('getEvidence',i=>this.#delivery.evidence(i.responseId)),
      requestLocalSummary:bind('requestLocalSummary',i=>this.#summaries.request(i.responseId)),getSummary:bind('getSummary',i=>this.#summaries.view(i.summaryId)),
      cancelJob:bind('cancelJob',i=>{
        const job=this.#store.get<JobRow>('SELECT * FROM jobs WHERE job_id=?',i.jobId);
        if(!job)throw new KuroError('ACCESS_DENIED');const local=this.#authority.authorizeLocal(job.space_id,'read');
        if(job.identity_id!==local)this.#authority.authorizeLocal(job.space_id,'share');
        this.#scheduler.cancel(i.jobId);return null;
      }),subscribe:listener=>this.#store.subscribe(listener),
    };
    }catch(error){this.#store.close();throw error;}
  }
  static async open(options:CoreOptions):Promise<CustodyCore>{
    const identity=await options.transport.start();
    let core:CustodyCore|undefined;
    try{core=new CustodyCore(options,identity.publicKey);await core.start();return core;}catch(error){if(core)core.#store.close();await options.transport.stop();throw error;}
  }
  private async invoke<K extends AppCommandName>(key:K,input:AppInput<K>,fn:(input:AppInput<K>)=>AppOutputs[K]|Promise<AppOutputs[K]>):Promise<Result<AppOutputs[K]>>{
    if(!this.#running)return failure('CANCELLED');
    const parsed=AppCommands[key].safeParse(input);if(!parsed.success)return failure('INVALID_INPUT');
    try{this.#authority.tick();return success(await fn(parsed.data as AppInput<K>));}
    catch(error){return failure(error instanceof KuroError?error.code:'STORAGE_FAILURE');}
  }
  async start():Promise<void>{
    if(this.#running)return;
    this.#authority.startup();this.#authority.resume(this.options.clockInitiallyTrusted);
    this.#store.transaction(()=>{
      // Unknown in-flight computations never resume from an unverified native callback.
      const interrupted=this.#store.all<JobRow>("SELECT * FROM jobs WHERE state='RUNNING' OR (kind='INDEX' AND state IN ('CANCELLED','EXPIRED','FAILED'))");
      this.#store.run("UPDATE jobs SET state='CANCELLED',error_code='CANCELLED' WHERE state='RUNNING'");
      this.#store.run("UPDATE summaries SET state='CANCELLED',error_code='CANCELLED' WHERE state='RUNNING'");
      for(const job of interrupted)this.jobFailed(job,'CANCELLED');
      const delta=this.options.clock.monotonicNowMs()-this.options.clock.wallNowMs();
      this.#store.run('UPDATE requests SET expires_mono=expires_wall+?',delta);
      this.#store.run('UPDATE approvals SET expires_mono=expires_wall+?',delta);
    });
    this.#running=true;this.#unsubscribe=this.options.transport.subscribe(event=>this.acceptEvent(event));
  }
  suspend():void{
    this.#authority.suspend();this.#lifecycleEpoch++;
    this.#store.transaction(()=>{for(const space of this.#authority.listSpaces())this.invalidate(space.spaceId,'stale');});
  }
  async resume(clockIsTrusted:boolean):Promise<void>{this.#authority.resume(clockIsTrusted);}
  private invalidate(spaceId:string,reason?:'policy'|'stale'|'expired'|'denied'|'corpus'|'index'):void{
    const s=this.#store;
    const active=s.all<{job_id:string}>("SELECT job_id FROM jobs WHERE space_id=? AND state='RUNNING'",spaceId);
    s.run(`UPDATE jobs SET state='CANCELLED',error_code='STALE_REVISION' WHERE space_id=? AND state IN ('QUEUED','RUNNING')${reason==='index'?" AND kind='SEARCH'":''}`,spaceId);
    s.run("UPDATE reviews SET state='CANCELLED' WHERE space_id=? AND state='REVIEW'",spaceId);
    s.run("UPDATE summaries SET state='CANCELLED',error_code='STALE_REVISION' WHERE space_id=? AND state IN ('SUMMARY_PENDING','RUNNING')",spaceId);
    s.run("UPDATE requests SET state='CANCELLED' WHERE space_id=? AND state IN ('QUEUED','RETRIEVING','REVIEW')",spaceId);
    // A changed or expired authority also ends outbound requests and releases their quota.
    // Lifecycle staleness alone may recover under unchanged policy and the original TTL.
    if(reason!=='stale')s.run("UPDATE requests SET state='CANCELLED' WHERE space_id=? AND state IN ('OUTGOING','RECEIVED')",spaceId);
    const filter=reason==='stale'?' AND attempts=0':'';
    s.run(`UPDATE outbox SET state='CANCELLED' WHERE response_id IN (SELECT response_id FROM approvals WHERE space_id=?) AND state<>'ACKED'${filter}`,spaceId);
    for(const job of active){
      const cancelled=s.get<{state:string}>('SELECT state FROM jobs WHERE job_id=?',job.job_id)?.state==='CANCELLED';
      if(cancelled)queueMicrotask(()=>{void this.options.ai.cancel(job.job_id).catch(()=>{});});
    }
  }
  private remapNamespace(oldSpace:string,newSpace:string):void{
    // Copy local snapshots/restrictions under explicit recovery. Old immutable provenance remains.
    const s=this.#store;
    s.run("INSERT INTO documents SELECT ?,document_id,version_id,revision+1,'PENDING' FROM documents WHERE space_id=?",newSpace,oldSpace);
    s.run('INSERT INTO versions SELECT ?,document_id,version_id,bytes,source_digest,local_path FROM versions WHERE space_id=?',newSpace,oldSpace);
    s.run('INSERT INTO spans SELECT ?,document_id,version_id,span_id,start_byte,end_byte,text,fingerprint FROM spans WHERE space_id=?',newSpace,oldSpace);
    s.run('INSERT INTO literal_index SELECT ?,document_id,version_id,span_id,text FROM literal_index WHERE space_id=?',newSpace,oldSpace);
  }
  private state():AppOutputs['getState']{
    this.#authority.requireSession();const spaces=this.#authority.listSpaces();
    const allowed=new Set(spaces.filter(space=>{try{this.#authority.authorizeLocal(space.spaceId,'read');return true;}catch{return false;}}).map(s=>s.spaceId));
    const documents=this.#store.all<DocumentRow>('SELECT * FROM documents ORDER BY document_id LIMIT 256').filter(d=>{
      if(!allowed.has(d.space_id))return false;try{const member=this.#authority.authorizeLocal(d.space_id,'read');this.#authority.assertDocument(d.space_id,d.document_id,member,'read');return true;}catch{return false;}
    }).map(d=>({documentId:d.document_id,spaceId:d.space_id,revision:d.revision,ingestionState:d.ingestion_state}));
    return StateViewSchema.parse({clockEpochValid:this.#authority.clockEpochValid,spaces,
      requests:this.#store.all<RequestRow>('SELECT * FROM requests ORDER BY admitted_wall DESC LIMIT 256').filter(r=>allowed.has(r.space_id)).map(r=>({requestId:r.request_id,spaceId:r.space_id,state:r.state})),
      jobs:this.#store.all<JobRow>('SELECT * FROM jobs ORDER BY sequence DESC LIMIT 256').filter(j=>allowed.has(j.space_id)).map(j=>({jobId:j.job_id,state:j.state})),documents,
      evidenceIds:this.#store.all<{response_id:string;space_id:string}>('SELECT response_id,space_id FROM inbox LIMIT 256').filter(r=>allowed.has(r.space_id)).map(r=>r.response_id),
      summaries:this.#store.all<SummaryRow>('SELECT * FROM summaries LIMIT 256').filter(r=>allowed.has(r.space_id)).map(r=>({summaryId:r.summary_id,state:r.state})),
    });
  }
  private runJob(job:JobRow):Promise<boolean>{
    return job.kind==='INDEX'?this.#retrieval.index(job):job.kind==='SEARCH'?this.#retrieval.search(job):this.#summaries.run(job);
  }
  private jobFailed(job:JobRow,code:string):void{
    const state=code==='CANCELLED'||code==='STALE_REVISION'?'CANCELLED':code==='EXPIRED'?'EXPIRED':'FAILED';
    this.#store.run("UPDATE requests SET state=? WHERE job_id=? AND state IN ('QUEUED','RETRIEVING')",state,job.job_id);
    this.#store.run("UPDATE summaries SET state=?,error_code=? WHERE job_id=? AND state IN ('SUMMARY_PENDING','RUNNING')",state,code,job.job_id);
    if(job.kind==='INDEX'){
      const generation=(JSON.parse(job.payload) as {generation:number}).generation;
      this.#store.run("UPDATE index_generations SET state='FAILED' WHERE space_id=? AND generation=? AND state='PENDING'",job.space_id,generation);
      this.#store.run("UPDATE documents SET ingestion_state='FAILED' WHERE space_id=? AND ingestion_state='PENDING'",job.space_id);
    }
  }
  private acceptEvent(event:TransportEvent):void{
    if(event.type!=='message'||!this.#running||this.#inboundCount>=128)return;
    const bytes=Uint8Array.from(event.bytes);if(bytes.byteLength>32768)return;
    this.#inboundCount++;
    this.#incoming=this.#incoming.then(()=>this.handleMessage(event.peerKey,bytes)).catch(()=>{}).finally(()=>{this.#inboundCount--;});
  }
  private async handleMessage(peer:string,bytes:Uint8Array):Promise<void>{
    let message;
    try{message=decodeWire(bytes);}catch{return;}
    try{
      let response:Uint8Array|null=null;
      switch(message.type){
        case 'SPACE_STATE_REQUEST':{
          const issued=this.#authority.handleRequest(peer,message);
          response=decodeWire(issued).type==='CLOSED'?issued:this.#authority.revalidatePublication(peer,message.requestId);break;
        }
        case 'SPACE_STATE_RESPONSE':this.#authority.handleResponse(peer,message,bytes);break;
        case 'SEARCH_REQUEST':response=this.#delivery.admit(peer,message);break;
        case 'APPROVED_RESPONSE':response=this.#delivery.receive(peer,message,bytes);break;
        case 'RESPONSE_ACK':this.#delivery.acceptAck(peer,message);break;
        case 'RECEIVED':case 'CLOSED':this.#delivery.acknowledgeRequest(peer,message);break;
      }
      if(response)await this.options.transport.send(peer,response);
    }catch(error){
      // No acknowledgment on failed storage; generic closures reveal no local diagnosis.
      if(error instanceof KuroError&&error.code!=='STORAGE_FAILURE'&&['SEARCH_REQUEST','SPACE_STATE_REQUEST'].includes(message.type)){
        await this.options.transport.send(peer,this.#delivery.closed(message)).catch(()=>{});
      }
    }
  }
  private backoff(attempts:number):number{return Math.min(60000,500*2**Math.min(7,attempts))+Math.floor(this.options.ids.randomUnit()*250);}
  async tick():Promise<void>{
    if(!this.#running||this.#ticking)return;this.#ticking=true;
    try{
      this.#authority.tick();await this.#incoming;
      for(const sync of this.#authority.pendingSyncSends())await this.options.transport.send(sync.peerKey,sync.bytes).catch(()=>{});
      const now=this.options.clock.wallNowMs();const mono=this.options.clock.monotonicNowMs();
      const expiredJobIds=this.#store.transaction(()=>{
        const jobs:string[]=[];
        const expired=this.#store.all<RequestRow>("SELECT * FROM requests WHERE state IN ('OUTGOING','RECEIVED','QUEUED','RETRIEVING','REVIEW') AND (expires_wall<=? OR expires_mono<=?)",now,mono);
        for(const row of expired){
          this.#store.run("UPDATE requests SET state='EXPIRED' WHERE request_id=?",row.request_id);
          this.#store.run("UPDATE reviews SET state='EXPIRED' WHERE request_id=? AND state='REVIEW'",row.request_id);
          if(row.job_id&&this.#store.run("UPDATE jobs SET state='EXPIRED',error_code='EXPIRED' WHERE job_id=? AND state IN ('QUEUED','RUNNING')",row.job_id).changes===1)jobs.push(row.job_id);
        }
        return jobs;
      });
      for(const jobId of expiredJobIds)void this.options.ai.cancel(jobId).catch(()=>{});
      for(const row of this.#store.all<RequestRow>("SELECT * FROM requests WHERE direction='OUT' AND state='OUTGOING' AND next_attempt<=? LIMIT 16",now)){
        try{
          const bytes=this.#store.transaction(()=>{
            this.#authority.authorizeLocal(row.space_id,'search');this.#authority.authorizePeer(row.space_id,row.peer_key,'share');
            // Authorization may apply a due policy change and cancel this selected request.
            const claimed=this.#store.run("UPDATE requests SET attempts=attempts+1,next_attempt=? WHERE request_id=? AND state='OUTGOING' AND expires_wall>? AND expires_mono>?",now+this.backoff(row.attempts),row.request_id,this.options.clock.wallNowMs(),this.options.clock.monotonicNowMs());
            return claimed.changes===1?Uint8Array.from(row.bytes):null;
          });if(bytes)await this.options.transport.send(row.peer_key,bytes);
        }catch{/* Retain original bytes/TTL. Authorization may recover only within their original bounds. */}
      }
      for(const row of this.#store.all<OutboxRow>("SELECT * FROM outbox WHERE state IN ('OUTBOX_READY','DISPATCHING','RETRY_WAIT') AND next_attempt<=? LIMIT 16",now)){
        try{
          const send=this.#delivery.authorizeDispatch(row.response_id);if(!send)continue;
          await this.options.transport.send(send.peerKey,send.bytes).catch(()=>{});
          this.#store.transaction(()=>this.#store.run("UPDATE outbox SET state='RETRY_WAIT',next_attempt=? WHERE response_id=? AND state='DISPATCHING'",now+this.backoff(row.attempts),row.response_id));
        }catch(error){
          if(error instanceof KuroError&&['ACCESS_DENIED','STALE_REVISION','EXPIRED'].includes(error.code))this.#store.transaction(()=>this.#store.run("UPDATE outbox SET state='CANCELLED' WHERE response_id=? AND state<>'ACKED'",row.response_id));
        }
      }
      if(this.#authority.clockEpochValid)this.#scheduler.startNext();
    }finally{this.#ticking=false;}
  }
  /** Harness/host drain; does not synthesize, approve or send anything by itself. */
  async settled():Promise<void>{await this.#incoming;await this.#scheduler.settled();}
  async stop():Promise<void>{
    if(!this.#running)return;this.#running=false;this.#unsubscribe?.();this.#unsubscribe=null;
    this.#authority.suspend();await this.#scheduler.stop();await this.#incoming;await this.options.transport.stop();this.#store.close();
  }
}
export const openCore=(options:CoreOptions):Promise<CustodyCore>=>CustodyCore.open(options);
