import { AiCapabilitiesSchema, CORE_LIMITS, KuroError, ModelProfileSchema, RankResultSchema, ReviewViewSchema,
  canonicalDigest, digestBytes, profileKey, validateVectors } from '@kuro/contracts';
import type { AppInput, ModelProfile, ReviewView, SpaceView } from '@kuro/contracts';
import type { CoreContext } from './context.js';
import type { DocumentRow, GenerationRow, JobRow, RequestRow, ReviewRow, SpanRow } from './rows.js';
import { passageFromRow, splitText } from './content.js';

export class Retrieval {
  constructor(private readonly c: CoreContext) {}
  async importText(input: AppInput<'importText'>): Promise<{documentId:string;versionId:string;jobId:string;revision:number}> {
    const {authority:a,store:s,files,ids}=this.c;
    a.authorizeLocal(input.spaceId,'manage'); a.authorizeLocal(input.spaceId,'read');
    const before=a.getSpace(input.spaceId);
    const lifecycle=this.c.lifecycleEpoch();
    this.c.scheduler.assertCapacity();
    const selected=await files.read(input.selectionId,CORE_LIMITS.maxImportBytes);
    if(selected.mediaType!=='text/plain') throw new KuroError('INVALID_INPUT');
    const capabilities=AiCapabilitiesSchema.parse(await this.c.ai.getCapabilities());
    const previous=s.get<GenerationRow>('SELECT * FROM index_generations WHERE space_id=? ORDER BY generation DESC LIMIT 1',input.spaceId);
    const profile=previous ? ModelProfileSchema.parse(JSON.parse(previous.profile_json)) : capabilities.embeddingProfiles[0];
    if(!capabilities.available || !profile || !capabilities.embeddingProfiles.some(p=>profileKey(p)===profileKey(profile))) throw new KuroError('MODEL_UNAVAILABLE');
    return s.transaction(()=>{
      this.c.assertEpoch(lifecycle);
      const member=a.authorizeLocal(input.spaceId,'manage'); a.authorizeLocal(input.spaceId,'read');
      const current=a.getSpace(input.spaceId);
      if(current.policyEpoch!==before.policyEpoch || current.corpusRevision!==before.corpusRevision) throw new KuroError('STALE_REVISION');
      const documentId=input.replaceDocumentId??ids.nextId(); const versionId=ids.nextId();
      const old=s.get<DocumentRow>('SELECT * FROM documents WHERE space_id=? AND document_id=?',input.spaceId,documentId);
      if(input.replaceDocumentId && (!old || old.revision!==input.expectedRevision)) throw new KuroError('STALE_REVISION');
      const count=s.get<{n:number}>('SELECT count(*) n FROM spans sp JOIN documents d ON d.space_id=sp.space_id AND d.document_id=sp.document_id AND d.version_id=sp.version_id WHERE d.space_id=? AND d.document_id<>?',input.spaceId,documentId)?.n??0;
      const split=splitText(selected.bytes,ids,Math.max(0,CORE_LIMITS.maxCorpusBlocks-count));
      if(!split.spans.length) throw new KuroError('CAPACITY_EXCEEDED');
      const revision=(old?.revision??0)+1;
      s.run('INSERT INTO documents VALUES (?,?,?,?,?) ON CONFLICT(space_id,document_id) DO UPDATE SET version_id=excluded.version_id,revision=excluded.revision,ingestion_state=excluded.ingestion_state',input.spaceId,documentId,versionId,revision,split.partial?'PARTIAL':'PENDING');
      s.run('INSERT INTO versions VALUES (?,?,?,?,?,?)',input.spaceId,documentId,versionId,selected.bytes,digestBytes(selected.bytes),selected.localPath);
      for(const span of split.spans){
        s.run('INSERT INTO spans VALUES (?,?,?,?,?,?,?,?)',input.spaceId,documentId,versionId,span.id,span.start,span.end,span.text,span.fingerprint);
        s.run('INSERT INTO literal_index VALUES (?,?,?,?,?)',input.spaceId,documentId,versionId,span.id,span.text);
      }
      a.setDocumentRules({spaceId:input.spaceId,documentId,rules:input.rules,expectedRevision:revision});
      const updated=a.bumpCorpus(input.spaceId);
      const jobId=this.newGeneration(updated,profile,member);
      s.emit({entity:'document',id:documentId,revision});
      return {documentId,versionId,jobId,revision};
    });
  }
  async setProfile(input: AppInput<'setIndexProfile'>): Promise<{jobId:string}> {
    const lifecycle=this.c.lifecycleEpoch();
    this.c.authority.authorizeLocal(input.spaceId,'manage');
    const caps=AiCapabilitiesSchema.parse(await this.c.ai.getCapabilities());
    if(!caps.available || !caps.embeddingProfiles.some(p=>profileKey(p)===profileKey(input.profile))) throw new KuroError('MODEL_UNAVAILABLE');
    return this.c.store.transaction(()=>{
      this.c.assertEpoch(lifecycle);
      const member=this.c.authority.authorizeLocal(input.spaceId,'manage');
      const current=this.c.authority.getSpace(input.spaceId);
      if(current.corpusRevision!==input.expectedRevision) throw new KuroError('STALE_REVISION');
      const updated=this.c.authority.bumpCorpus(input.spaceId);
      return {jobId:this.newGeneration(updated,input.profile,member)};
    });
  }
  reindexAfterPolicyChange(spaceId:string):void{
    const latest=this.c.store.get<GenerationRow>('SELECT * FROM index_generations WHERE space_id=? ORDER BY generation DESC LIMIT 1',spaceId);
    if(!latest)return;
    const member=this.c.authority.authorizeLocal(spaceId,'manage');
    this.newGeneration(this.c.authority.getSpace(spaceId),ModelProfileSchema.parse(JSON.parse(latest.profile_json)),member);
  }
  private newGeneration(space: SpaceView,profile: ModelProfile,member: string): string {
    const s=this.c.store;
    const generation=(s.get<{n:number}>('SELECT max(generation) n FROM index_generations WHERE space_id=?',space.spaceId)?.n??0)+1;
    s.run("UPDATE index_generations SET state='OBSOLETE' WHERE space_id=? AND state='PENDING'",space.spaceId);
    s.run("INSERT INTO index_generations VALUES (?,?,?,?,'PENDING')",space.spaceId,generation,JSON.stringify(profile),space.corpusRevision);
    return this.c.scheduler.enqueue('INDEX',space,member,{generation});
  }
  async index(job: JobRow): Promise<boolean> {
    const {store:s,authority:a}=this.c;
    this.c.assertJob(job);
    const generationId=(JSON.parse(job.payload) as {generation:number}).generation;
    const generation=s.get<GenerationRow>("SELECT * FROM index_generations WHERE space_id=? AND generation=? AND state='PENDING'",job.space_id,generationId);
    if(!generation || generation.corpus_revision!==job.corpus_revision) throw new KuroError('STALE_REVISION');
    const profile=ModelProfileSchema.parse(JSON.parse(generation.profile_json));
    const member=a.authorizeLocal(job.space_id,'read');
    const predicate=a.documentPredicate(job.space_id,member,'read','d');
    const pending=s.all<SpanRow>(`SELECT sp.* FROM spans sp JOIN documents d ON d.space_id=sp.space_id AND d.document_id=sp.document_id AND d.version_id=sp.version_id WHERE d.space_id=? AND ${predicate.sql} AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.space_id=sp.space_id AND e.generation=? AND e.document_id=sp.document_id AND e.version_id=sp.version_id AND e.span_id=sp.span_id) ORDER BY d.document_id,sp.start_byte LIMIT ?`,job.space_id,...predicate.params,generationId,CORE_LIMITS.indexingBatchSize);
    if(!pending.length){
      s.transaction(()=>{
        this.c.assertJob(job);
        // This generation is complete for the current authorized set; excluded sources
        // remain visibly incomplete and any ACL broadening queues another generation.
        s.run("UPDATE index_generations SET state='COMPLETE' WHERE space_id=? AND generation=?",job.space_id,generationId);
        a.activateIndex(job.space_id,generationId);
        s.run(`UPDATE documents AS d SET ingestion_state='COMPLETE' WHERE d.space_id=? AND d.ingestion_state IN ('PENDING','FAILED') AND ${predicate.sql}`,job.space_id,...predicate.params);
        s.run("UPDATE documents SET ingestion_state='FAILED' WHERE space_id=? AND ingestion_state='PENDING'",job.space_id);
      });
      return false;
    }
    const vectors=new Map<string,number[]>();
    const missing:SpanRow[]=[];
    for(const row of pending){
      const reused=s.get<{vector:Uint8Array}>('SELECT vector FROM embeddings WHERE space_id=? AND profile_key=? AND fingerprint=? LIMIT 1',job.space_id,profileKey(profile),row.fingerprint);
      if(reused){
        const bytes=Uint8Array.from(reused.vector); const values=Array.from(new Float32Array(bytes.buffer));
        vectors.set(row.span_id,validateVectors({jobId:job.job_id,profile,vectors:[{id:row.span_id,values}]},job.job_id,profile,[row.span_id]).vectors[0]!.values);
      }else missing.push(row);
    }
    if(missing.length){
      const output=await this.c.ai.embedBlocks({jobId:job.job_id,profile,blocks:missing.map(row=>({id:row.span_id,text:row.text,ref:passageFromRow(row,this.c.publicKey).ref}))});
      for(const vector of validateVectors(output,job.job_id,profile,missing.map(r=>r.span_id)).vectors) vectors.set(vector.id,vector.values);
    }
    s.transaction(()=>{
      this.c.assertJob(job);
      for(const row of pending){
        a.assertDocument(job.space_id,row.document_id,member,'read');
        s.run('INSERT INTO embeddings VALUES (?,?,?,?,?,?,?,?)',job.space_id,generationId,row.document_id,row.version_id,row.span_id,profileKey(profile),row.fingerprint,new Uint8Array(Float32Array.from(vectors.get(row.span_id)!).buffer));
      }
    });
    return true;
  }
  requireCompleteIndex(spaceId:string):GenerationRow {
    const space=this.c.authority.getSpace(spaceId);
    const latest=this.c.store.get<{generation:number}>('SELECT generation FROM index_generations WHERE space_id=? ORDER BY generation DESC LIMIT 1',spaceId);
    if(latest&&latest.generation!==space.indexGeneration)throw new KuroError('INCOMPLETE_INDEX');
    const index=this.c.store.get<GenerationRow>("SELECT * FROM index_generations WHERE space_id=? AND generation=? AND state='COMPLETE'",spaceId,space.indexGeneration);
    if(!index || index.corpus_revision!==space.corpusRevision) throw new KuroError('INCOMPLETE_INDEX');
    return index;
  }
  async search(job:JobRow):Promise<boolean>{
    const {store:s,authority:a,clock}=this.c;
    this.c.assertJob(job);
    const request=s.get<RequestRow>('SELECT * FROM requests WHERE job_id=?',job.job_id);
    if(!request || request.expires_wall<=clock.wallNowMs() || request.expires_mono<=clock.monotonicNowMs()) throw new KuroError('EXPIRED');
    const requester=a.authorizePeer(job.space_id,request.peer_key,'search');
    const reviewer=a.authorizeLocal(job.space_id,'read');
    a.authorizePeer(job.space_id,request.peer_key,'receive');
    const index=this.requireCompleteIndex(job.space_id); const profile=ModelProfileSchema.parse(JSON.parse(index.profile_json));
    s.transaction(()=>s.run("UPDATE requests SET state='RETRIEVING' WHERE request_id=?",request.request_id));
    const embedded=validateVectors(await this.c.ai.embedBlocks({jobId:job.job_id,profile,blocks:[{id:request.request_id,text:request.query,ref:null}]}),job.job_id,profile,[request.request_id]);
    this.c.assertJob(job);
    const read=a.documentPredicate(job.space_id,reviewer,'read','d');
    const receive=a.documentPredicate(job.space_id,requester,'receive','d');
    // SQL permissions precede copying either vectors or literal candidate identifiers.
    const allowed=s.all<{span_id:string;vector:Uint8Array;profile_key:string}>(`SELECT e.span_id,e.vector,e.profile_key FROM embeddings e JOIN documents d ON d.space_id=e.space_id AND d.document_id=e.document_id AND d.version_id=e.version_id WHERE e.space_id=? AND e.generation=? AND ${read.sql} AND ${receive.sql} ORDER BY e.span_id LIMIT ?`,job.space_id,index.generation,...read.params,...receive.params,CORE_LIMITS.maxCorpusBlocks);
    const candidates=allowed.map(row=>{
      if(row.profile_key!==profileKey(profile)) throw new KuroError('INCOMPLETE_INDEX');
      const bytes=Uint8Array.from(row.vector);
      const vector={id:row.span_id,values:Array.from(new Float32Array(bytes.buffer))};
      return validateVectors({jobId:job.job_id,profile,vectors:[vector]},job.job_id,profile,[row.span_id]).vectors[0]!;
    });
    const raw=RankResultSchema.parse(await this.c.ai.rankAllowed({jobId:job.job_id,profile,query:embedded.vectors[0]!,candidates,limit:CORE_LIMITS.vectorCandidates}));
    if(raw.jobId!==job.job_id || raw.ranked.length>CORE_LIMITS.vectorCandidates || new Set(raw.ranked.map(r=>r.id)).size!==raw.ranked.length || raw.ranked.some(r=>!allowed.some(v=>v.span_id===r.id))) throw new KuroError('INVALID_MODEL_OUTPUT');
    this.c.assertJob(job);
    const terms=request.query.match(/[\p{L}\p{N}]+/gu)?.slice(0,16)??[];
    const literal=terms.length?s.all<{span_id:string}>(`SELECT l.span_id FROM literal_index l JOIN documents d ON d.space_id=l.space_id AND d.document_id=l.document_id AND d.version_id=l.version_id WHERE l.text MATCH ? AND d.space_id=? AND ${read.sql} AND ${receive.sql} ORDER BY rank,l.span_id LIMIT ?`,terms.map(t=>'"'+t+'"').join(' OR '),job.space_id,...read.params,...receive.params,CORE_LIMITS.literalCandidates):[];
    const fused=new Map<string,number>();
    for(const list of [raw.ranked.map(r=>r.id),literal.map(r=>r.span_id)]) list.forEach((id,i)=>fused.set(id,(fused.get(id)??0)+1/(60+i+1)));
    const chosen=[...fused].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,6).map(([id])=>id);
    s.transaction(()=>{
      this.c.assertJob(job); a.authorizePeer(job.space_id,request.peer_key,'receive');
      const passages=chosen.map(id=>{
        const row=s.get<SpanRow>('SELECT sp.* FROM spans sp JOIN documents d ON d.space_id=sp.space_id AND d.document_id=sp.document_id AND d.version_id=sp.version_id WHERE sp.space_id=? AND sp.span_id=?',job.space_id,id);
        if(!row)throw new KuroError('STALE_REVISION');
        a.assertDocument(job.space_id,row.document_id,reviewer,'read');a.assertDocument(job.space_id,row.document_id,requester,'receive');
        return passageFromRow(row,this.c.publicKey);
      });
      const draftId=this.c.ids.nextId(); const space=a.getSpace(job.space_id);
      const partial=(s.get<{n:number}>("SELECT count(*) n FROM documents WHERE space_id=? AND ingestion_state<>'COMPLETE'",job.space_id)?.n??0)>0;
      const body:Omit<ReviewView,'viewDigest'>={draftId,requestId:request.request_id,spaceId:job.space_id,revision:1,recipientKey:request.peer_key,question:request.query,passages,selectedSpanIds:passages.map(p=>p.ref.spanId),conditions:{v:1,allowLocalSummary:false,forwarding:'forbidden',validForSeconds:3600,notAfterMs:request.expires_wall},policyEpoch:space.policyEpoch,corpusRevision:space.corpusRevision,indexGeneration:space.indexGeneration,coverage:partial?'PARTIAL':passages.length?'COMPLETE':'EMPTY',expiresAtMs:Math.min(request.expires_wall,clock.wallNowMs()+CORE_LIMITS.reviewRetentionMs)};
      const view={...body,viewDigest:canonicalDigest(body)};
      s.run("INSERT INTO reviews VALUES (?,?,?,1,'REVIEW',?)",draftId,request.request_id,job.space_id,JSON.stringify(view));
      s.run("UPDATE requests SET state='REVIEW' WHERE request_id=?",request.request_id);
      s.emit({entity:'review',id:draftId,revision:1});
    });return false;
  }
  review(draftId:string):ReviewView{
    const row=this.c.store.get<ReviewRow>('SELECT * FROM reviews WHERE draft_id=?',draftId);
    if(!row || row.state!=='REVIEW')throw new KuroError('STALE_REVISION');
    const view=ReviewViewSchema.parse(JSON.parse(row.view_json));
    const a=this.c.authority;const reviewer=a.authorizeLocal(view.spaceId,'read');const recipient=a.authorizePeer(view.spaceId,view.recipientKey,'receive');
    const space=a.getSpace(view.spaceId);
    if(view.expiresAtMs<=this.c.clock.wallNowMs())throw new KuroError('EXPIRED');
    if(view.policyEpoch!==space.policyEpoch||view.corpusRevision!==space.corpusRevision||view.indexGeneration!==space.indexGeneration)throw new KuroError('STALE_REVISION');
    for(const passage of view.passages){a.assertDocument(view.spaceId,passage.ref.documentId,reviewer,'read');a.assertDocument(view.spaceId,passage.ref.documentId,recipient,'receive');}
    return view;
  }
  revise(input:AppInput<'reviseDraft'>):ReviewView{
    return this.c.store.transaction(()=>{
      const view=this.review(input.draftId);
      if(view.revision!==input.expectedRevision||view.viewDigest!==input.reviewedViewDigest)throw new KuroError('STALE_REVISION');
      if(new Set(input.selectedSpanIds).size!==input.selectedSpanIds.length||input.selectedSpanIds.some(id=>!view.passages.some(p=>p.ref.spanId===id)))throw new KuroError('INVALID_INPUT');
      if(input.conditions.notAfterMs===null||input.conditions.notAfterMs>view.expiresAtMs)throw new KuroError('INVALID_INPUT');
      const {viewDigest:_digest,...body}=view;
      const updated={...body,revision:view.revision+1,selectedSpanIds:input.selectedSpanIds,conditions:input.conditions};
      const next={...updated,viewDigest:canonicalDigest(updated)};
      this.c.store.run('UPDATE reviews SET revision=?,view_json=? WHERE draft_id=?',next.revision,JSON.stringify(next),input.draftId);
      this.c.store.emit({entity:'review',id:input.draftId,revision:next.revision});return next;
    });
  }
}
