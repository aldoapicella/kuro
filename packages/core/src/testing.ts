/** Explicit simulations for tests and the independent harness. Never select automatically. */
import { KuroError, SUMMARY_PROMPT_VERSION, SUMMARY_SCHEMA_VERSION, canonicalDigest, digestBytes, preparationDigest, summaryContext } from '@kuro/contracts';
import type { AiCapabilities, AiPort, Clock, EmbeddingResult, GenerationProfile, IdSource, IdentifiedVector, LocalSession, ModelProfile, PreparedSummary, RankResult, SelectedFilePort, SessionPort, SummaryPreparationInput, SummaryResult, VerifiedBinding, VerifiedPairingPort } from '@kuro/contracts';

export class FakeClock implements Clock {
  constructor(public wall=1_800_000_000_000,public mono=0){}
  wallNowMs():number{return this.wall;}
  monotonicNowMs():number{return this.mono;}
  advance(ms:number):void{this.wall+=ms;this.mono+=ms;}
}
export class FakeIds implements IdSource {
  #counter=0;
  constructor(private readonly namespace:string){}
  nextId():string{return digestBytes(new TextEncoder().encode(`${this.namespace}:${++this.#counter}`)).slice(0,32);}
  randomUnit():number{return 0;}
}
export class FakeSession implements SessionPort {
  constructor(public session:LocalSession|null){}
  current():LocalSession|null{return this.session?{...this.session}:null;}
}
export class MemorySelectedFiles implements SelectedFilePort {
  #values=new Map<string,Uint8Array>();
  constructor(private readonly ids:IdSource){}
  add(text:string|Uint8Array):string{const id=this.ids.nextId();this.#values.set(id,typeof text==='string'?new TextEncoder().encode(text):Uint8Array.from(text));return id;}
  async read(selectionId:string,maxBytes:number):Promise<{bytes:Uint8Array;mediaType:'text/plain';localPath:null}>{
    const bytes=this.#values.get(selectionId);this.#values.delete(selectionId);
    if(!bytes||bytes.length>maxBytes)throw new KuroError('INVALID_INPUT');return {bytes:Uint8Array.from(bytes),mediaType:'text/plain',localPath:null};
  }
}
export class FakePairing implements VerifiedPairingPort {
  #bindings=new Map<string,VerifiedBinding>();
  constructor(private readonly ids:IdSource){}
  verify(binding:VerifiedBinding):string{const id=this.ids.nextId();this.#bindings.set(id,structuredClone(binding));return id;}
  async consume(selectionId:string):Promise<VerifiedBinding>{const b=this.#bindings.get(selectionId);this.#bindings.delete(selectionId);if(!b)throw new KuroError('ACCESS_DENIED');return structuredClone(b);}
}
export const FAKE_EMBEDDING_PROFILE:ModelProfile={modelId:'KURO-simulated-embedding',modelChecksum:'a'.repeat(64),dimension:8,normalization:'unit',segmentationVersion:'utf8-1500-v1'};
export const FAKE_GENERATION_PROFILE:GenerationProfile={modelId:'KURO-simulated-summary',modelChecksum:'b'.repeat(64),tokenizerId:'synthetic-byte-upper-bound',contextTokens:4096,outputTokens:512};
export class FakeAiPort implements AiPort {
  available=true;
  generationAvailable=true;
  readonly calls:{method:string;input:unknown}[]=[];
  beforeOperation:((method:string,jobId:string)=>Promise<void>)|null=null;
  #cancelled=new Set<string>();
  async getCapabilities():Promise<AiCapabilities>{return {provider:'simulated',embeddingProfiles:[FAKE_EMBEDDING_PROFILE],generationProfiles:this.generationAvailable?[FAKE_GENERATION_PROFILE]:[],available:this.available};}
  private async enter(method:string,jobId:string,input:unknown):Promise<void>{
    this.calls.push({method,input:structuredClone(input)});
    if(!this.available)throw new KuroError('MODEL_UNAVAILABLE');
    await this.beforeOperation?.(method,jobId);
    if(this.#cancelled.has(jobId))throw new KuroError('CANCELLED');
  }
  async embedBlocks(input:Parameters<AiPort['embedBlocks']>[0]):Promise<EmbeddingResult>{
    await this.enter('embedBlocks',input.jobId,input);
    return {jobId:input.jobId,profile:input.profile,vectors:input.blocks.map(block=>{
      const digest=digestBytes(new TextEncoder().encode(block.text.toLowerCase()));
      const raw=Array.from({length:input.profile.dimension},(_,i)=>(Number.parseInt(digest.slice((i%32)*2,(i%32)*2+2),16)+1)/256);
      const norm=Math.hypot(...raw);return {id:block.id,values:Array.from(Float32Array.from(raw.map(v=>v/norm)))};
    })};
  }
  async rankAllowed(input:Parameters<AiPort['rankAllowed']>[0]):Promise<RankResult>{
    await this.enter('rankAllowed',input.jobId,input);
    const cosine=(v:IdentifiedVector)=>v.values.reduce((sum,x,i)=>sum+x*input.query.values[i]!,0)/(Math.hypot(...v.values)*Math.hypot(...input.query.values));
    return {jobId:input.jobId,ranked:input.candidates.map(v=>({id:v.id,score:cosine(v)})).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,input.limit)};
  }
  async prepareSummary(input:SummaryPreparationInput):Promise<PreparedSummary>{
    await this.enter('prepareSummary',input.jobId,input);if(!this.generationAvailable)throw new KuroError('MODEL_UNAVAILABLE');
    const sources:PreparedSummary['sources']=[];const omittedReferences:PreparedSummary['omittedReferences']=[];
    for(const passage of input.passages){
      const trial=[...sources,{alias:`P${sources.length+1}`,passage}];
      if(new TextEncoder().encode(summaryContext(input.question,trial)).length+input.profile.outputTokens<=input.profile.contextTokens)sources.push(trial.at(-1)!);else omittedReferences.push(passage.ref);
    }
    if(!sources.length)throw new KuroError('CAPACITY_EXCEEDED');
    const context=summaryContext(input.question,sources);
    const body:Omit<PreparedSummary,'digest'>={jobId:input.jobId,preparationId:input.preparationId,deliveryId:input.deliveryId,profile:input.profile,promptVersion:SUMMARY_PROMPT_VERSION,schemaVersion:SUMMARY_SCHEMA_VERSION,question:input.question,questionDigest:canonicalDigest(input.question),sources,omittedReferences,context,contextTokens:new TextEncoder().encode(context).length,reservedOutputTokens:input.profile.outputTokens,tokenAccounting:'validated-byte-upper-bound'};
    return {...body,digest:preparationDigest(body)};
  }
  async runPreparedSummary(input:PreparedSummary):Promise<SummaryResult>{
    await this.enter('runPreparedSummary',input.jobId,input);if(!this.generationAvailable)throw new KuroError('MODEL_UNAVAILABLE');
    return {jobId:input.jobId,preparationDigest:input.digest,status:'answer',completion:'complete',claims:input.sources.slice(0,4).map(source=>({text:`Simulated draft: ${source.passage.text}`.slice(0,400),sourceAliases:[source.alias]}))};
  }
  async cancel(jobId:string):Promise<void>{this.#cancelled.add(jobId);this.calls.push({method:'cancel',input:{jobId}});}
}
