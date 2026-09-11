import { CORE_LIMITS, KuroError } from '@kuro/contracts';
import type { AiPort, Clock, IdSource, SpaceView } from '@kuro/contracts';
import type { Store } from './store.js';
import type { JobRow } from './rows.js';

/** One durable queue and one in-flight provider operation for the installation. */
export class Scheduler {
  #active: { id: string; promise: Promise<void> } | null = null;
  #stopped = false;
  constructor(private readonly store: Store, private readonly clock: Clock, private readonly ids: IdSource,
    private readonly ai: AiPort, private readonly run: (job: JobRow) => Promise<boolean>,
    private readonly failed: (job: JobRow, code: string) => void) {}

  assertCapacity(): void {
    const count = this.store.get<{ n:number }>("SELECT count(*) n FROM jobs WHERE state='QUEUED'")?.n ?? 0;
    if (count >= CORE_LIMITS.maxWaitingJobs) throw new KuroError('CAPACITY_EXCEEDED');
  }
  enqueue(kind: JobRow['kind'], space: SpaceView, identityId: string, payload: unknown, jobId = this.ids.nextId()): string {
    this.assertCapacity();
    this.store.run("INSERT INTO jobs(job_id,space_id,identity_id,kind,payload,state,policy_epoch,corpus_revision,index_generation) VALUES (?,?,?,?,?,'QUEUED',?,?,?)", jobId,space.spaceId,identityId,kind,JSON.stringify(payload),space.policyEpoch,space.corpusRevision,space.indexGeneration);
    this.store.emit({ entity:'job', id:jobId, revision:0 });
    return jobId;
  }
  valid(job: JobRow): void {
    const current = this.store.get<JobRow>('SELECT * FROM jobs WHERE job_id=?',job.job_id);
    if (!current || current.state !== 'RUNNING') throw new KuroError('CANCELLED');
    if ((current.deadline_wall ?? 0) <= this.clock.wallNowMs() || (current.deadline_mono ?? 0) <= this.clock.monotonicNowMs()) throw new KuroError('EXPIRED');
  }
  cancel(jobId: string): void {
    this.store.transaction(() => {
      this.store.run("UPDATE jobs SET state='CANCELLED',error_code='CANCELLED' WHERE job_id=? AND state IN ('QUEUED','RUNNING')",jobId);
      const job = this.store.get<JobRow>('SELECT * FROM jobs WHERE job_id=?',jobId);
      if (job) this.failed(job,'CANCELLED');
    });
    void this.ai.cancel(jobId).catch(() => {});
  }
  startNext(): void {
    if (this.#active || this.#stopped) return;
    const last = this.store.get<{value:string}>("SELECT value FROM core_meta WHERE key='scheduler_last_identity'")?.value ?? '';
    const waiting = this.store.all<JobRow>("SELECT * FROM jobs WHERE state='QUEUED' ORDER BY identity_id,sequence");
    const job = waiting.find(j => j.identity_id > last) ?? waiting[0];
    if (!job) return;
    const remaining = CORE_LIMITS.computationDeadlineMs - job.computation_ms;
    const started = this.clock.monotonicNowMs();
    this.store.transaction(() => {
      this.store.run("UPDATE jobs SET state='RUNNING',deadline_wall=?,deadline_mono=? WHERE job_id=?",this.clock.wallNowMs()+remaining,started+remaining,job.job_id);
      this.store.run("INSERT INTO core_meta VALUES ('scheduler_last_identity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",job.identity_id);
      this.store.emit({entity:'job',id:job.job_id,revision:1});
    });
    const timeout = setTimeout(() => {
      this.store.transaction(() => {
        this.store.run("UPDATE jobs SET state='EXPIRED',error_code='EXPIRED' WHERE job_id=? AND state='RUNNING'",job.job_id);
        this.failed(job,'EXPIRED');
      });
      void this.ai.cancel(job.job_id).catch(() => {});
    },Math.max(1,remaining));
    timeout.unref();
    // Keep the slot until the provider settles, even if cancellation/deadline fired.
    const promise = Promise.resolve().then(() => this.run(job)).then(more => {
      this.store.transaction(() => {
        this.valid(job);
        const elapsed = Math.max(0,this.clock.monotonicNowMs()-started);
        this.store.run('UPDATE jobs SET state=?,computation_ms=computation_ms+?,deadline_wall=NULL,deadline_mono=NULL WHERE job_id=?',more?'QUEUED':'COMPLETE',elapsed,job.job_id);
        this.store.emit({entity:'job',id:job.job_id,revision:2});
      });
    }).catch(error => {
      const code = error instanceof KuroError ? error.code : 'INVALID_MODEL_OUTPUT';
      this.store.transaction(() => {
        this.store.run("UPDATE jobs SET state=?,error_code=? WHERE job_id=? AND state='RUNNING'",code==='EXPIRED'?'EXPIRED':['CANCELLED','CLOCK_UNCERTAIN'].includes(code)?'CANCELLED':'FAILED',code,job.job_id);
        this.failed(job,code);
      });
    }).finally(() => { clearTimeout(timeout); this.#active = null; });
    this.#active = {id:job.job_id,promise};
  }
  async settled(): Promise<void> { await this.#active?.promise; }
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#active) { this.cancel(this.#active.id); await this.#active.promise; }
  }
  get busy(): boolean { return this.#active !== null; }
}
