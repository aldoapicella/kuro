import type { AiPort, Clock, IdSource, SelectedFilePort } from '@kuro/contracts';
import type { Store } from './store.js';
import type { Authority } from './authority.js';
import type { Scheduler } from './scheduler.js';
import type { JobRow } from './rows.js';
export interface CoreContext {
  store: Store; authority: Authority; scheduler: Scheduler; ai: AiPort; clock: Clock;
  ids: IdSource; files: SelectedFilePort; publicKey: string; processId: string;
  assertJob(job: JobRow,checkCorpus?:boolean): void;
  lifecycleEpoch():number;
  assertEpoch(epoch:number):void;
}
