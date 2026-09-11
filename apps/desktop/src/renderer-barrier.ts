import { KuroError } from '@kuro/contracts';

/** Private preload protocol. The renderer only receives named AppPort results.
 * Check synchronously after each async reply and before a visible frame so an
 * IPC response queued before a wake notification cannot repopulate a cleared view. */
export class RendererBarrier {
  private epoch: number | undefined;
  private invalidated = false;
  private revision = 0;
  constructor(private readonly readEpoch: () => unknown, private readonly clear: () => void) {}
  invalidate(): void {
    this.epoch = undefined;
    this.revision++;
    if (!this.invalidated) this.clear();
    this.invalidated = true;
  }
  check(): number {
    const epoch = this.readEpoch();
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) {
      this.invalidate();
      throw new KuroError('CLOCK_UNCERTAIN');
    }
    if (this.epoch !== undefined && epoch !== this.epoch) this.invalidate();
    this.epoch = epoch;
    this.invalidated = false;
    return epoch;
  }
  async deliver<T>(operation: () => Promise<T>): Promise<T> {
    const epoch = this.check();
    const revision = this.revision;
    const result = await operation();
    if (this.check() !== epoch || revision !== this.revision) throw new KuroError('CLOCK_UNCERTAIN');
    return result;
  }
}
