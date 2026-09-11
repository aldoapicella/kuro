export type ExclusiveOutcome<T> =
  | { readonly kind: "busy" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "done"; readonly value: T };

interface ActiveOperation { readonly jobId: string; requestId: string | null; cancelled: boolean; }

/** A guard only: core owns durable scheduling, this adapter refuses overlap. */
export class ExecutionGuard {
  #active: ActiveOperation | null = null;
  get activeJobId(): string | null { return this.#active?.jobId ?? null; }
  get activeRequestId(): string | null { return this.#active?.requestId ?? null; }
  throwIfCancelled(): void { if (this.#active?.cancelled === true) throw new Error("operation cancelled"); }
  trackRequest(requestId: string): void { if (this.#active !== null) this.#active.requestId = requestId; }
  markCancelled(jobId: string): boolean {
    if (this.#active === null || this.#active.jobId !== jobId) return false;
    this.#active.cancelled = true;
    return true;
  }
  async run<T>(jobId: string, operation: () => Promise<T>): Promise<ExclusiveOutcome<T>> {
    if (this.#active !== null) return { kind: "busy" };
    const active: ActiveOperation = { jobId, requestId: null, cancelled: false };
    this.#active = active;
    try {
      const value = await operation();
      return active.cancelled ? { kind: "cancelled" } : { kind: "done", value };
    } catch (error) {
      if (active.cancelled) return { kind: "cancelled" };
      throw error;
    } finally { this.#active = null; }
  }
}
