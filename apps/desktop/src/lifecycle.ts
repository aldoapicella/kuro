import type { CoreLifecyclePort } from '@kuro/contracts';

/** A synchronous closing barrier; resume never asserts unverified clock trust. */
export class DesktopLifecycle {
  private closed = false;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly cores: readonly CoreLifecyclePort[], private readonly closeRuntime: () => Promise<void> = async () => {}) {}
  suspend(): void {
    if (this.closed) return;
    let failure: unknown;
    for (const core of this.cores) {
      try { core.suspend(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  async resume(): Promise<void> { if (!this.closed) for (const core of this.cores) await core.resume(false); }
  tick(): Promise<void> {
    if (this.closed) return this.pending;
    const current = this.pending.then(async () => { if (!this.closed) for (const core of this.cores) await core.tick(); });
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
