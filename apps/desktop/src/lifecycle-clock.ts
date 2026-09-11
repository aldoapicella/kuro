import { KuroError } from '@kuro/contracts';
import type { Clock } from '@kuro/contracts';

export interface ClockSample { sleepEpoch: bigint; wallMs: number; monotonicMs: number }

/** Host-only clock. A fresh native sample is required on EVERY Clock read.
 * Closing is latched: a later good read cannot silently renew old authority. */
export class LifecycleClock implements Clock {
  private previous: ClockSample;
  private uncertain = false;
  onUncertain: () => void = () => {};
  constructor(private readonly sample: () => ClockSample) { this.previous = this.validSample(); }
  get trusted(): boolean { return !this.uncertain; }
  close(): void { this.uncertain = true; }
  wallNowMs(): number { return this.read().wallMs; }
  monotonicNowMs(): number { return this.read().monotonicMs; }
  check(): void { this.read(); }

  /** Only the trusted lifecycle coordinator may rebase, after durable suspend.
   * High-water marks survive rebasing; a rollback cannot be blessed as recovery. */
  rebase(): void {
    const sample = this.validSample();
    this.checkProgress(sample);
    this.previous = sample;
    this.uncertain = false;
  }
  private read(): ClockSample {
    if (this.uncertain) throw new KuroError('CLOCK_UNCERTAIN');
    try {
      const sample = this.validSample();
      this.checkProgress(sample);
      if (sample.sleepEpoch !== this.previous.sleepEpoch) throw new KuroError('CLOCK_UNCERTAIN');
      this.previous = sample;
      return sample;
    } catch {
      this.uncertain = true;
      // Latch first. The callback may reenter Clock or encounter a failed writer.
      try { this.onUncertain(); } catch { /* Coordinator retries durable suspend before reopening. */ }
      throw new KuroError('CLOCK_UNCERTAIN');
    }
  }
  private validSample(): ClockSample {
    const value = this.sample();
    if (typeof value.sleepEpoch !== 'bigint' || value.sleepEpoch < 0n ||
      !Number.isSafeInteger(value.wallMs) || value.wallMs < 0 ||
      !Number.isSafeInteger(value.monotonicMs) || value.monotonicMs < 0) throw new KuroError('CLOCK_UNCERTAIN');
    return value;
  }
  private checkProgress(sample: ClockSample): void {
    if (sample.sleepEpoch < this.previous.sleepEpoch || sample.wallMs < this.previous.wallMs ||
      sample.monotonicMs < this.previous.monotonicMs) throw new KuroError('CLOCK_UNCERTAIN');
  }
}
