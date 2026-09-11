import { KuroError, canonicalDigest, decodeWire, digestBytes, encodeWire } from '@kuro/contracts';
import type { AppInput, ApprovedResponse, EvidenceView, Passage, ResponseAck, SearchRequest, WireMessage } from '@kuro/contracts';
import type { CoreContext } from './context.js';
import type { ApprovalRow, InboxRow, OutboxRow, RequestRow, SpanRow } from './rows.js';
import type { Retrieval } from './retrieval.js';
import { passageFromRow, selectedPassages } from './content.js';

export class Delivery {
  constructor(private readonly c:CoreContext,private readonly retrieval:Retrieval){}
  submit(input:AppInput<'submitQuestion'>):{requestId:string}{
    const {store:s,authority:a,clock,ids}=this.c;
    return s.transaction(()=>{
      const member=a.authorizeLocal(input.spaceId,'search');a.authorizePeer(input.spaceId,input.custodianKey,'share');
      this.assertIdentityQuota(member);
      const alias=a.aliasForPeer(input.spaceId,input.custodianKey);const space=a.getSpace(input.spaceId);const requestId=ids.nextId();
      const message:SearchRequest={v:1,type:'SEARCH_REQUEST',requestId,spaceAlias:alias,ttlSeconds:input.ttlSeconds,query:input.query,audienceKey:input.custodianKey};
      const bytes=encodeWire(message); const wall=clock.wallNowMs();const mono=clock.monotonicNowMs();
      s.run("INSERT INTO requests(request_id,direction,space_id,peer_key,member_id,space_alias,bytes,digest,query,state,admitted_wall,expires_wall,expires_mono,policy_epoch,corpus_revision,index_generation) VALUES (?,'OUT',?,?,?,?,?,?,?,'OUTGOING',?,?,?,?,?,?)",requestId,input.spaceId,input.custodianKey,member,alias,bytes,canonicalDigest(message),input.query,wall,wall+input.ttlSeconds*1000,mono+input.ttlSeconds*1000,space.policyEpoch,space.corpusRevision,space.indexGeneration);
      s.emit({entity:'request',id:requestId,revision:1});return {requestId};
    });
  }
  private assertIdentityQuota(member:string):void{
    const n=this.c.store.get<{n:number}>("SELECT count(*) n FROM requests WHERE member_id=? AND state IN ('OUTGOING','RECEIVED','QUEUED','RETRIEVING','REVIEW')",member)?.n??0;
    if(n>=1)throw new KuroError('CAPACITY_EXCEEDED');
  }
  admit(peer:string,message:SearchRequest):Uint8Array{
    const {store:s,authority:a,clock,ids}=this.c;
    if(message.audienceKey!==this.c.publicKey)throw new KuroError('ACCESS_DENIED');
    return s.transaction(()=>{
      const prior=s.get<RequestRow>('SELECT * FROM requests WHERE request_id=?',message.requestId);
      if(prior){
        if(prior.peer_key!==peer||prior.direction!=='IN'||prior.digest!==canonicalDigest(message))throw new KuroError('INVALID_MESSAGE');
        if(prior.expires_wall<=clock.wallNowMs()||prior.expires_mono<=clock.monotonicNowMs()||['CANCELLED','EXPIRED','CLOSED','FAILED'].includes(prior.state))return this.closed(message);
        a.authorizePeer(prior.space_id,peer,'search');
        return encodeWire({v:1,type:'RECEIVED',requestId:message.requestId,spaceAlias:message.spaceAlias});
      }
      const spaceId=a.spaceForPeer(peer,message.spaceAlias);const member=a.authorizePeer(spaceId,peer,'search');
      a.authorizePeer(spaceId,peer,'receive');a.authorizeLocal(spaceId,'read');
      this.assertIdentityQuota(member);this.c.scheduler.assertCapacity();this.retrieval.requireCompleteIndex(spaceId);
      const space=a.getSpace(spaceId); const jobId=ids.nextId();const wall=clock.wallNowMs();const mono=clock.monotonicNowMs();
      s.run("INSERT INTO requests(request_id,direction,space_id,peer_key,member_id,space_alias,bytes,digest,query,state,admitted_wall,expires_wall,expires_mono,policy_epoch,corpus_revision,index_generation,job_id) VALUES (?,'IN',?,?,?,?,?,?,?,'QUEUED',?,?,?,?,?,?,?)",message.requestId,spaceId,peer,member,message.spaceAlias,encodeWire(message),canonicalDigest(message),message.query,wall,wall+message.ttlSeconds*1000,mono+message.ttlSeconds*1000,space.policyEpoch,space.corpusRevision,space.indexGeneration,jobId);
      this.c.scheduler.enqueue('SEARCH',space,member,{requestId:message.requestId},jobId);
      s.checkpoint('before_received_commit');s.emit({entity:'request',id:message.requestId,revision:1});
      return encodeWire({v:1,type:'RECEIVED',requestId:message.requestId,spaceAlias:message.spaceAlias});
    });
  }
  approve(input:AppInput<'approveDraft'>):{responseId:string}{
    const {store:s,authority:a,clock,ids}=this.c;
    return s.transaction(()=>{
      const view=this.retrieval.review(input.draftId);
      if(view.revision!==input.expectedRevision||view.viewDigest!==input.reviewedViewDigest)throw new KuroError('STALE_REVISION');
      const reviewer=a.authorizeLocal(view.spaceId,'share');const recipient=a.authorizePeer(view.spaceId,view.recipientKey,'receive');
      const passages=selectedPassages(view);if(!passages.length)throw new KuroError('INVALID_INPUT');
      for(const passage of passages){
        a.assertDocument(view.spaceId,passage.ref.documentId,reviewer,'read');a.assertDocument(view.spaceId,passage.ref.documentId,reviewer,'share');a.assertDocument(view.spaceId,passage.ref.documentId,recipient,'receive');
        const source=s.get<SpanRow>('SELECT sp.* FROM spans sp JOIN documents d ON d.space_id=sp.space_id AND d.document_id=sp.document_id AND d.version_id=sp.version_id WHERE sp.space_id=? AND sp.document_id=? AND sp.version_id=? AND sp.span_id=?',view.spaceId,passage.ref.documentId,passage.ref.versionId,passage.ref.spanId);
        if(!source||canonicalDigest(passageFromRow(source,this.c.publicKey))!==canonicalDigest(passage))throw new KuroError('STALE_REVISION');
      }
      const request=s.get<RequestRow>('SELECT * FROM requests WHERE request_id=?',view.requestId)!;
      if(request.state!=='REVIEW'||request.expires_wall<=clock.wallNowMs()||request.expires_mono<=clock.monotonicNowMs())throw new KuroError('EXPIRED');
      const responseId=ids.nextId();const message:ApprovedResponse={v:1,type:'APPROVED_RESPONSE',requestId:request.request_id,responseId,spaceAlias:request.space_alias,passages,conditions:view.conditions};
      const bytes=encodeWire(message);const digest=digestBytes(bytes);
      const expires=Math.min(request.expires_wall,view.expiresAtMs,view.conditions.notAfterMs??Number.MAX_SAFE_INTEGER);
      s.run('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',responseId,view.draftId,view.requestId,view.spaceId,view.recipientKey,reviewer,view.viewDigest,bytes,digest,JSON.stringify(passages),view.policyEpoch,view.corpusRevision,view.indexGeneration,expires,Math.min(request.expires_mono,clock.monotonicNowMs()+expires-clock.wallNowMs()));
      s.checkpoint('after_approval_insert');
      s.run("INSERT INTO outbox(response_id,state) VALUES (?,'OUTBOX_READY')",responseId);
      s.run("UPDATE reviews SET state='APPROVED',revision=revision+1 WHERE draft_id=?",view.draftId);
      s.run("UPDATE requests SET state='APPROVED',response_id=? WHERE request_id=?",responseId,request.request_id);
      s.emit({entity:'delivery',id:responseId,revision:1});return {responseId};
    });
  }
  authorizeDispatch(responseId:string):{peerKey:string;bytes:Uint8Array}|null{
    const {store:s,authority:a,clock}=this.c;
    return s.transaction(()=>{
      const approval=s.get<ApprovalRow>('SELECT * FROM approvals WHERE response_id=?',responseId);
      const outbox=s.get<OutboxRow>('SELECT * FROM outbox WHERE response_id=?',responseId);
      if(!approval||!outbox||!['OUTBOX_READY','DISPATCHING','RETRY_WAIT'].includes(outbox.state))return null;
      if(approval.expires_wall<=clock.wallNowMs()||approval.expires_mono<=clock.monotonicNowMs()){
        s.run("UPDATE outbox SET state='EXPIRED' WHERE response_id=?",responseId);return null;
      }
      const reviewer=a.authorizeLocal(approval.space_id,'share');if(reviewer!==approval.reviewer_id)throw new KuroError('ACCESS_DENIED');
      const recipient=a.authorizePeer(approval.space_id,approval.peer_key,'receive');const space=a.getSpace(approval.space_id);
      if(approval.policy_epoch!==space.policyEpoch||approval.corpus_revision!==space.corpusRevision||approval.index_generation!==space.indexGeneration)throw new KuroError('STALE_REVISION');
      const passages=JSON.parse(approval.dependencies) as Passage[];
      for(const p of passages){a.assertDocument(approval.space_id,p.ref.documentId,reviewer,'read');a.assertDocument(approval.space_id,p.ref.documentId,reviewer,'share');a.assertDocument(approval.space_id,p.ref.documentId,recipient,'receive');}
      if(digestBytes(approval.bytes)!==approval.digest)throw new KuroError('STORAGE_FAILURE');
      s.run("UPDATE outbox SET state='DISPATCHING',attempts=attempts+1 WHERE response_id=?",responseId);
      s.checkpoint('dispatch_authorized');return {peerKey:approval.peer_key,bytes:Uint8Array.from(approval.bytes)};
    });
  }
  receive(peer:string,message:ApprovedResponse,bytes:Uint8Array):Uint8Array|null{
    const {store:s,authority:a,clock}=this.c;const digest=digestBytes(bytes);
    return s.transaction(()=>{
      const prior=s.get<InboxRow>('SELECT * FROM inbox WHERE peer_key=? AND response_id=?',peer,message.responseId);
      if(prior){
        if(prior.digest!==digest||prior.request_id!==message.requestId||prior.space_alias!==message.spaceAlias)throw new KuroError('INVALID_MESSAGE');
        // Content-free ACK of already persisted bytes remains legal after access expires.
        return this.ack(message,digest);
      }
      const request=s.get<RequestRow>('SELECT * FROM requests WHERE request_id=?',message.requestId);
      if(!request||request.direction!=='OUT'||request.peer_key!==peer||request.space_alias!==message.spaceAlias||!['OUTGOING','RECEIVED'].includes(request.state))throw new KuroError('INVALID_MESSAGE');
      a.authorizeLocal(request.space_id,'receive');a.authorizePeer(request.space_id,peer,'share');
      // Applying a due policy change during authorization may have cancelled this request.
      const current=s.get<{state:string}>('SELECT state FROM requests WHERE request_id=?',request.request_id);
      if(!current||!['OUTGOING','RECEIVED'].includes(current.state))return null;
      if(request.expires_wall<=clock.wallNowMs()||request.expires_mono<=clock.monotonicNowMs())throw new KuroError('EXPIRED');
      if(message.passages.some(p=>p.ref.originKey!==peer))throw new KuroError('INVALID_MESSAGE');
      const wall=clock.wallNowMs();const expires=Math.min(request.expires_wall,wall+message.conditions.validForSeconds*1000,message.conditions.notAfterMs??Number.MAX_SAFE_INTEGER);
      if(expires<=wall)throw new KuroError('EXPIRED');
      s.run('INSERT INTO inbox VALUES (?,?,?,?,?,?,?,?,?,?,?)',peer,message.responseId,message.requestId,request.space_id,message.spaceAlias,bytes,digest,wall,expires,clock.monotonicNowMs()+expires-wall,this.c.processId);
      message.passages.forEach((passage,i)=>s.run('INSERT INTO received_spans VALUES (?,?,?,?)',peer,message.responseId,i,JSON.stringify(passage)));
      s.run("UPDATE requests SET state='EVIDENCE_READY',response_id=? WHERE request_id=?",message.responseId,message.requestId);
      s.checkpoint('before_receipt_commit');s.emit({entity:'evidence',id:message.responseId,revision:1});
      return this.ack(message,digest);
    });
  }
  acceptAck(peer:string,message:ResponseAck):void{
    const s=this.c.store;
    s.transaction(()=>{
      const approval=s.get<ApprovalRow>('SELECT * FROM approvals WHERE response_id=?',message.responseId);
      const request=s.get<RequestRow>('SELECT * FROM requests WHERE request_id=?',message.requestId);
      if(!approval||!request||approval.peer_key!==peer||approval.request_id!==message.requestId||request.space_alias!==message.spaceAlias||approval.digest!==message.bodyDigest)throw new KuroError('INVALID_MESSAGE');
      s.run("UPDATE outbox SET state='ACKED' WHERE response_id=?",message.responseId);s.emit({entity:'delivery',id:message.responseId,revision:2});
    });
  }
  acknowledgeRequest(peer:string,message:Extract<WireMessage,{type:'RECEIVED'|'CLOSED'}>):void{
    this.c.store.transaction(()=>{
      const row=this.c.store.get<RequestRow>('SELECT * FROM requests WHERE request_id=?',message.requestId);
      if(!row||row.direction!=='OUT'||row.peer_key!==peer||row.space_alias!==message.spaceAlias)throw new KuroError('INVALID_MESSAGE');
      if(!['OUTGOING','RECEIVED'].includes(row.state))return;
      this.c.store.run('UPDATE requests SET state=? WHERE request_id=?',message.type==='RECEIVED'?'RECEIVED':'CLOSED',message.requestId);
      this.c.store.emit({entity:'request',id:message.requestId,revision:2});
    });
  }
  evidence(responseId:string):EvidenceView{
    const {store:s,authority:a,clock}=this.c;
    const row=s.get<InboxRow>('SELECT * FROM inbox WHERE response_id=?',responseId);if(!row)throw new KuroError('ACCESS_DENIED');
    a.authorizeLocal(row.space_id,'read');a.authorizeLocal(row.space_id,'receive');a.authorizePeer(row.space_id,row.peer_key,'share');
    if(row.expires_wall<=clock.wallNowMs()||(row.received_process===this.c.processId&&row.expires_mono<=clock.monotonicNowMs()))throw new KuroError('EXPIRED');
    if(digestBytes(row.bytes)!==row.digest)throw new KuroError('STORAGE_FAILURE');
    const message=decodeWire(row.bytes);if(message.type!=='APPROVED_RESPONSE')throw new KuroError('STORAGE_FAILURE');
    const request=s.get<RequestRow>('SELECT * FROM requests WHERE request_id=?',row.request_id)!;
    return {responseId,requestId:row.request_id,spaceId:row.space_id,senderKey:row.peer_key,question:request.query,passages:message.passages,conditions:message.conditions,receivedAtMs:row.first_receipt_wall,expiresAtMs:row.expires_wall,bodyDigest:row.digest};
  }
  closed(message:{requestId:string;spaceAlias:string}):Uint8Array{return encodeWire({v:1,type:'CLOSED',requestId:message.requestId,spaceAlias:message.spaceAlias});}
  private ack(message:ApprovedResponse,digest:string):Uint8Array{return encodeWire({v:1,type:'RESPONSE_ACK',requestId:message.requestId,responseId:message.responseId,spaceAlias:message.spaceAlias,bodyDigest:digest});}
}
