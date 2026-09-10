import { AiCapabilitiesSchema, KuroError, PreparedSummarySchema, SummaryResultSchema, canonicalDigest, validatePreparation } from '@kuro/contracts';
import type { SummaryPreparationInput, SummaryView } from '@kuro/contracts';
import type { CoreContext } from './context.js';
import type { Delivery } from './delivery.js';
import type { JobRow, SummaryRow } from './rows.js';

export class Summaries {
  constructor(private readonly c:CoreContext,private readonly delivery:Delivery){}
  async request(responseId:string):Promise<{summaryId:string;jobId:string}>{
    const lifecycle=this.c.lifecycleEpoch();
    const evidence=this.delivery.evidence(responseId);
    if(!evidence.conditions.allowLocalSummary)throw new KuroError('ACCESS_DENIED');
    const caps=AiCapabilitiesSchema.parse(await this.c.ai.getCapabilities());
    const profile=caps.generationProfiles[0];if(!caps.available||!profile)throw new KuroError('MODEL_UNAVAILABLE');
    return this.c.store.transaction(()=>{
      this.c.assertEpoch(lifecycle);
      const current=this.delivery.evidence(responseId);
      if(current.bodyDigest!==evidence.bodyDigest||!current.conditions.allowLocalSummary)throw new KuroError('STALE_REVISION');
      const existing=this.c.store.get<{n:number}>("SELECT count(*) n FROM summaries WHERE response_id=? AND state IN ('SUMMARY_PENDING','RUNNING')",responseId)?.n??0;
      if(existing)throw new KuroError('CAPACITY_EXCEEDED');
      const summaryId=this.c.ids.nextId();const space=this.c.authority.getSpace(evidence.spaceId);
      const member=this.c.authority.authorizeLocal(evidence.spaceId,'receive');
      const jobId=this.c.scheduler.enqueue('SUMMARY',space,member,{summaryId,profile});
      this.c.store.run("INSERT INTO summaries(summary_id,job_id,response_id,space_id,state,policy_epoch,expires_wall) VALUES (?,?,?,?,'SUMMARY_PENDING',?,?)",summaryId,jobId,responseId,evidence.spaceId,space.policyEpoch,evidence.expiresAtMs);
      this.c.store.emit({entity:'summary',id:summaryId,revision:1});return {summaryId,jobId};
    });
  }
  async run(job:JobRow):Promise<boolean>{
    this.c.assertJob(job,false);
    const row=this.c.store.get<SummaryRow>('SELECT * FROM summaries WHERE job_id=?',job.job_id);
    if(!row||!['SUMMARY_PENDING','RUNNING'].includes(row.state))throw new KuroError('CANCELLED');
    const evidence=this.delivery.evidence(row.response_id);
    if(!evidence.conditions.allowLocalSummary)throw new KuroError('ACCESS_DENIED');
    const payload=JSON.parse(job.payload) as {summaryId:string;profile:SummaryPreparationInput['profile']};
    const input:SummaryPreparationInput={jobId:job.job_id,preparationId:this.c.ids.nextId(),deliveryId:row.response_id,profile:payload.profile,question:evidence.question,passages:evidence.passages};
    const prepared=validatePreparation(await this.c.ai.prepareSummary(input),input);
    this.c.store.transaction(()=>{
      this.c.assertJob(job,false);
      const latest=this.delivery.evidence(row.response_id);
      if(latest.bodyDigest!==evidence.bodyDigest||!latest.conditions.allowLocalSummary)throw new KuroError('STALE_REVISION');
      this.c.store.run("UPDATE summaries SET state='RUNNING',preparation_json=? WHERE summary_id=?",JSON.stringify(prepared),row.summary_id);
      this.c.store.checkpoint('before_manifest_commit');this.c.store.emit({entity:'summary',id:row.summary_id,revision:2});
    });
    // Execute only the committed manifest, then verify the adapter's result boundary.
    this.c.assertJob(job,false);this.delivery.evidence(row.response_id);
    const persisted=this.c.store.get<SummaryRow>('SELECT * FROM summaries WHERE summary_id=?',row.summary_id)!;
    const preparation=PreparedSummarySchema.parse(JSON.parse(persisted.preparation_json!));
    if(canonicalDigest(preparation)!==canonicalDigest(prepared))throw new KuroError('STORAGE_FAILURE');
    const output=SummaryResultSchema.parse(await this.c.ai.runPreparedSummary(preparation));
    if(output.jobId!==job.job_id||output.preparationDigest!==preparation.digest||output.claims.some(c=>c.sourceAliases.some(alias=>!preparation.sources.some(s=>s.alias===alias))))throw new KuroError('INVALID_MODEL_OUTPUT');
    this.c.store.transaction(()=>{
      this.c.assertJob(job,false);this.delivery.evidence(row.response_id);
      this.c.store.run("UPDATE summaries SET state='DRAFT',result_json=? WHERE summary_id=? AND state='RUNNING'",JSON.stringify(output),row.summary_id);
      this.c.store.emit({entity:'summary',id:row.summary_id,revision:3});
    });return false;
  }
  view(summaryId:string):SummaryView{
    const row=this.c.store.get<SummaryRow>('SELECT * FROM summaries WHERE summary_id=?',summaryId);
    if(!row)throw new KuroError('ACCESS_DENIED');this.delivery.evidence(row.response_id);
    const preparation=row.preparation_json?PreparedSummarySchema.parse(JSON.parse(row.preparation_json)):null;
    const result=row.result_json?SummaryResultSchema.parse(JSON.parse(row.result_json)):null;
    return {summaryId,responseId:row.response_id,state:row.state as SummaryView['state'],preparationDigest:preparation?.digest??null,requiresSemanticReview:true,
      claims:result&&preparation?result.claims.map(claim=>({text:claim.text,quotes:claim.sourceAliases.map(alias=>preparation.sources.find(source=>source.alias===alias)!.passage)})):[]};
  }
}
