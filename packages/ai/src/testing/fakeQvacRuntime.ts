import { ExecutionGuard, type ExclusiveOutcome } from "../executionGuard.js";
import { QVAC_EMBEDDING_PROFILE, QVAC_GENERATION_PROFILE, type CompletionOutcome, type CompletionRequest, type CompletionStopReason, type QvacRuntime } from "../qvacClient.js";

export interface FakeQvacScript {
  readonly embeddingDimension?: number;
  readonly embeddingVectors?: readonly number[][];
  readonly completionResponses?: readonly string[];
  readonly embedError?: Error;
  readonly completionError?: Error;
  readonly cancelError?: Error;
  readonly embeddingLoadGate?: Promise<void>;
  readonly generationLoadGate?: Promise<void>;
  readonly completionGate?: Promise<void>;
  readonly completionStopReason?: CompletionStopReason;
}
/** Scripted backend only; it never loads or executes a QVAC model. */
export class FakeQvacRuntime implements QvacRuntime {
  readonly provider = "simulated" as const;
  readonly #guard = new ExecutionGuard();
  #closed = false;
  #completionIndex = 0;
  readonly calls = { ensureEmbeddingModelLoaded: 0, ensureGenerationModelLoaded: 0, embedTexts: 0, runCompletion: 0, close: 0, cancel: 0 };
  constructor(private readonly script: FakeQvacScript = {}) {}
  get activeJobId(): string | null { return this.#guard.activeJobId; }
  async ensureEmbeddingModelLoaded(): Promise<string> { this.#assertOpen(); this.calls.ensureEmbeddingModelLoaded += 1; this.#guard.trackRequest(`embedding-load-${this.calls.ensureEmbeddingModelLoaded}`); if (this.script.embeddingLoadGate !== undefined) await this.script.embeddingLoadGate; this.#guard.throwIfCancelled(); return QVAC_EMBEDDING_PROFILE.modelId; }
  async ensureGenerationModelLoaded(): Promise<string> { this.#assertOpen(); this.calls.ensureGenerationModelLoaded += 1; this.#guard.trackRequest(`generation-load-${this.calls.ensureGenerationModelLoaded}`); if (this.script.generationLoadGate !== undefined) await this.script.generationLoadGate; this.#guard.throwIfCancelled(); return QVAC_GENERATION_PROFILE.modelId; }
  async embedTexts(_modelId: string, texts: readonly string[]): Promise<number[][]> {
    this.calls.embedTexts += 1; this.#guard.trackRequest(`embed-${this.calls.embedTexts}`);
    if (this.script.embedError !== undefined) throw this.script.embedError;
    return this.script.embeddingVectors?.map((vector) => [...vector]) ?? texts.map((text) => deterministicVector(text, this.script.embeddingDimension ?? QVAC_EMBEDDING_PROFILE.dimension));
  }
  async runCompletion(_request: CompletionRequest): Promise<CompletionOutcome> {
    this.calls.runCompletion += 1; this.#guard.trackRequest(`completion-${this.calls.runCompletion}`);
    if (this.script.completionGate !== undefined) await this.script.completionGate;
    if (this.script.completionError !== undefined) throw this.script.completionError;
    const responses = this.script.completionResponses ?? ["{\"status\":\"insufficient\",\"claims\":[]}"];
    return { contentText: responses[Math.min(this.#completionIndex++, responses.length - 1)]!, stopReason: this.script.completionStopReason ?? "eos" };
  }
  async withExclusiveOperation<T>(jobId: string, operation: () => Promise<T>): Promise<ExclusiveOutcome<T>> { this.#assertOpen(); return this.#guard.run(jobId, operation); }
  throwIfCancelled(): void { this.#guard.throwIfCancelled(); }
  async cancel(jobId: string): Promise<void> { this.calls.cancel += 1; if (!this.#guard.markCancelled(jobId)) return; if (this.script.cancelError !== undefined) throw this.script.cancelError; }
  async close(): Promise<void> { if (this.#closed) return; this.#closed = true; this.calls.close += 1; }
  #assertOpen(): void { if (this.#closed) throw new Error("Fake QVAC runtime is closed"); }
}
export function deterministicVector(text: string, dimension: number): number[] {
  const values = Array.from({ length: dimension }, (_, index) => { let hash = 2166136261 ^ index; for (const char of text) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); } return ((hash >>> 0) % 1000) + 1; });
  const norm = Math.hypot(...values); return values.map((value) => value / norm);
}
