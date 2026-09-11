import type { CoreLifecyclePort } from '@kuro/contracts';

/** A synchronous closing barrier; resume never asserts unverified clock trust. */
export class DesktopLifecycle {
  private closed = false;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly cores: readonly CoreLifecyclePort[], private readonly closeRuntime: () => Promise<void> = async () => {}) {}
  suspend(): void { if (!this.closed) for (const core of this.cores) core.suspend(); }
  async resume(): Promise<void> { if (!this.closed) for (const core of this.cores) await core.resume(false); }
  tick(): Promise<void> {
    if (this.closed) return this.pending;
    this.pending = this.pending.then(async () => { if (!this.closed) for (const core of this.cores) await core.tick(); });
    return this.pending;
  }
  async close(): Promise<void> {
    if (this.closed) return this.pending;
    this.suspend(); this.closed = true;
    this.pending = this.pending.catch(() => {}).then(async () => {
      const results = await Promise.allSettled(this.cores.map(core => core.stop()));
      await this.closeRuntime();
      if (results.some(result => result.status === 'rejected')) throw new Error('KURO shutdown failed');
    });
    return this.pending;
  }
}
