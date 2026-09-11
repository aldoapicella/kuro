import type { CoreLifecyclePort } from '@kuro/contracts';
import { KuroError } from '@kuro/contracts';
import type { LifecycleClock } from './lifecycle-clock.js';

/** Native reads are the wake barrier; queued Electron events only close it sooner. */
export class DesktopLifecycle {
  private closed = false;
  private suspended = false;
  private locked = false;
  private epoch = 0;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly cores: readonly CoreLifecyclePort[], private readonly closeRuntime: () => Promise<void> = async () => {},
    private readonly clock?: LifecycleClock, private readonly invalidateViews: () => void = () => {}) {
    if (clock) clock.onUncertain = () => this.suspend();
  }
  /** A trusted host check before/after callbacks and renderer frame delivery. */
  checkpoint(): number {
    if (this.closed || this.suspended) throw new KuroError('CLOCK_UNCERTAIN');
    this.clock?.check();
    return this.epoch;
  }
  suspend(): void {
    if (this.closed) return;
    this.suspended = true;
    this.epoch++;
    this.clock?.close();
    // Also runs if durable cancellation fails. Protected UI cannot stay visible.
    this.invalidateViews();
    this.suspendCores();
  }
  private suspendCores(): void {
    let failure: unknown;
    for (const core of this.cores) {
      try { core.suspend(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  lock(): void { this.locked = true; this.suspend(); }
  unlock(): Promise<void> { this.locked = false; return this.resume(); }
  resume(): Promise<void> { return this.enqueue(() => this.recover()); }
  private async recover(): Promise<void> {
    if (this.closed || this.locked) return;
    if (!this.suspended) { this.clock?.check(); return; }
    const epoch = this.epoch;
    try {
      // Repeat OUTSIDE the interrupted transaction: its rollback may have undone
      // the first cancellation. No core is reopened if this commit fails.
      this.suspendCores();
      this.clock?.rebase();
      for (const core of this.cores) await core.resume(this.clock?.trusted ?? false);
      this.clock?.check();
      if (this.closed || this.locked || epoch !== this.epoch) throw new KuroError('CLOCK_UNCERTAIN');
      this.suspended = false;
    } catch (error) { this.suspend(); throw error; }
  }
  tick(): Promise<void> {
    return this.enqueue(async () => {
      if (this.suspended) await this.recover();
      this.checkpoint();
      for (const core of this.cores) await core.tick();
      this.checkpoint();
    });
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return this.pending;
    const current = this.pending.then(async () => { if (!this.closed) await operation(); });
    this.pending = current.catch(() => {});
    return current;
  }
  async close(): Promise<void> {
    if (this.closed) return this.pending;
    let suspendFailed = false;
    try { this.suspend(); } catch { suspendFailed = true; }
    this.closed = true;
    this.pending = this.pending.catch(() => {}).then(async () => {
      const results = await Promise.allSettled(this.cores.map(core => core.stop()));
      await this.closeRuntime();
      if (suspendFailed || results.some(result => result.status === 'rejected')) throw new Error('KURO shutdown failed');
    });
    return this.pending;
  }
}
