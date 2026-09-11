import { ContextOverflowError, GTE_LARGE_FP16, QWEN3_1_7B_INST_Q4, cancel as qvacCancel, close as qvacClose, completion, embed, loadModel, unloadModel } from "@qvac/sdk";
import { ExecutionGuard, type ExclusiveOutcome } from "./executionGuard.js";

/** Values come from the pinned @qvac/sdk 0.19 registry descriptors. */
export const QVAC_EMBEDDING_PROFILE = Object.freeze({ modelId: GTE_LARGE_FP16.name, modelChecksum: GTE_LARGE_FP16.sha256Checksum, dimension: 1024, normalization: "unit" as const, segmentationVersion: "utf8-v1" });
export const QVAC_GENERATION_PROFILE = Object.freeze({ modelId: QWEN3_1_7B_INST_Q4.name, modelChecksum: QWEN3_1_7B_INST_Q4.sha256Checksum, tokenizerId: QWEN3_1_7B_INST_Q4.name, contextTokens: 4096, outputTokens: 512 });
/** Exact registry artifacts; QVAC verifies descriptor checksums after fallback retrieval. */
export const EMBEDDING_FALLBACK_SRC = "https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/f9fa5479908e72c2a8b9d6ba112911cd1e51be53/gte-large_fp16.gguf";
export const GENERATION_FALLBACK_SRC = "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_0.gguf";

export class ContextBudgetExceededError extends Error { constructor() { super("QVAC rejected the prepared context budget"); this.name = "ContextBudgetExceededError"; } }
export interface CompletionRequest { readonly modelId: string; readonly context: string; readonly outputTokens: number; readonly schema: Record<string, unknown>; }
export type CompletionStopReason = "eos" | "stopSequence" | "length" | "cancelled" | "error" | "unknown";
export interface CompletionOutcome { readonly contentText: string; readonly stopReason: CompletionStopReason; }
/**
 * @qvac/sdk@0.19.0 dist/examples/completion-stop-reason.js documents an
 * undefined final.stopReason as natural EOS. Do not broaden that exception:
 * null and any unrecognized value remain unsafe terminal states.
 */
export function normalizeCompletionStopReason(value: unknown): CompletionStopReason {
  if (value === undefined || value === "eos") return "eos";
  if (value === "stopSequence" || value === "length" || value === "cancelled" || value === "error") return value;
  return "unknown";
}
/** The sole SDK seam; tests supply a scripted implementation without a model. */
export interface QvacRuntime {
  readonly provider: "qvac" | "simulated";
  readonly activeJobId: string | null;
  throwIfCancelled(): void;
  ensureEmbeddingModelLoaded(): Promise<string>;
  ensureGenerationModelLoaded(): Promise<string>;
  embedTexts(modelId: string, texts: readonly string[]): Promise<number[][]>;
  runCompletion(request: CompletionRequest): Promise<CompletionOutcome>;
  withExclusiveOperation<T>(jobId: string, operation: () => Promise<T>): Promise<ExclusiveOutcome<T>>;
  /** Marks cancellation first. A provider cancellation failure leaves the guard occupied until its call settles. */
  cancel(jobId: string): Promise<void>;
  close(): Promise<void>;
}
export interface QvacClientOptions {
  readonly embeddingFallbackSrc?: string | null; readonly generationFallbackSrc?: string | null;
  /** Trusted host supplies already checksum-verified local weights. This disables registry and download lookup. */
  readonly localModelPath?: (kind: 'embedding' | 'summary') => string | Promise<string>;
}

export class QvacClient implements QvacRuntime {
  readonly provider = "qvac" as const;
  #embeddingModelId: string | null = null;
  #generationModelId: string | null = null;
  #closed = false;
  #closing: Promise<void> | null = null;
  readonly #guard = new ExecutionGuard();
  readonly #embeddingFallbackSrc: string | null;
  readonly #generationFallbackSrc: string | null;
  readonly #localModelPath: QvacClientOptions['localModelPath'];
  constructor(options: QvacClientOptions = {}) {
    this.#embeddingFallbackSrc = options.embeddingFallbackSrc === undefined ? EMBEDDING_FALLBACK_SRC : options.embeddingFallbackSrc;
    this.#generationFallbackSrc = options.generationFallbackSrc === undefined ? GENERATION_FALLBACK_SRC : options.generationFallbackSrc;
    this.#localModelPath = options.localModelPath;
  }
  get activeJobId(): string | null { return this.#guard.activeJobId; }
  async ensureEmbeddingModelLoaded(): Promise<string> {
    this.#assertOpen();
    if (this.#embeddingModelId === null) {
      const localPath = await this.#localModelPath?.('embedding');
      this.#guard.throwIfCancelled();
      if (this.#localModelPath && (typeof localPath !== "string" || !localPath.startsWith("/"))) throw new Error("Verified local model is unavailable");
      const load = this.#localModelPath === undefined
        ? loadModel({ modelSrc: GTE_LARGE_FP16, ...(this.#embeddingFallbackSrc === null ? {} : { fallbackSrc: this.#embeddingFallbackSrc }) })
        : loadModel({ modelSrc: localPath!, modelType: 'llamacpp-embedding' });
      this.#guard.trackRequest(load.requestId);
      this.#embeddingModelId = await load;
      this.#guard.throwIfCancelled();
    }
    return this.#embeddingModelId;
  }
  async ensureGenerationModelLoaded(): Promise<string> {
    this.#assertOpen();
    if (this.#generationModelId === null) {
      const localPath = await this.#localModelPath?.('summary');
      this.#guard.throwIfCancelled();
      if (this.#localModelPath && (typeof localPath !== "string" || !localPath.startsWith("/"))) throw new Error("Verified local model is unavailable");
      const load = this.#localModelPath === undefined
        ? loadModel({ modelSrc: QWEN3_1_7B_INST_Q4, modelConfig: { ctx_size: QVAC_GENERATION_PROFILE.contextTokens }, ...(this.#generationFallbackSrc === null ? {} : { fallbackSrc: this.#generationFallbackSrc }) })
        : loadModel({ modelSrc: localPath!, modelType: 'llamacpp-completion', modelConfig: { ctx_size: QVAC_GENERATION_PROFILE.contextTokens } });
      this.#guard.trackRequest(load.requestId);
      this.#generationModelId = await load;
      this.#guard.throwIfCancelled();
    }
    return this.#generationModelId;
  }
  async embedTexts(modelId: string, texts: readonly string[]): Promise<number[][]> {
    const request = embed({ modelId, text: [...texts] });
    this.#guard.trackRequest(request.requestId);
    return (await request).embedding;
  }
  async runCompletion(request: CompletionRequest): Promise<CompletionOutcome> {
    const run = completion({ modelId: request.modelId, history: [{ role: "user", content: request.context }], stream: false, kvCache: false, generationParams: { temp: 0, seed: 42, predict: request.outputTokens }, responseFormat: { type: "json_schema", json_schema: { name: "kuro_grounded_summary", schema: request.schema } } });
    this.#guard.trackRequest(run.requestId);
    try {
      const final = await run.final;
      return { contentText: final.contentText, stopReason: normalizeCompletionStopReason(final.stopReason) };
    } catch (error) { if (error instanceof ContextOverflowError) throw new ContextBudgetExceededError(); throw error; }
  }
  async withExclusiveOperation<T>(jobId: string, operation: () => Promise<T>): Promise<ExclusiveOutcome<T>> { this.#assertOpen(); return this.#guard.run(jobId, operation); }
  throwIfCancelled(): void { this.#guard.throwIfCancelled(); }
  async cancel(jobId: string): Promise<void> {
    if (!this.#guard.markCancelled(jobId)) return;
    const requestId = this.#guard.activeRequestId;
    if (requestId !== null) await qvacCancel({ requestId });
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#closing !== null) return this.#closing;
    this.#closing = (async () => {
      let failure: unknown;
      if (this.#embeddingModelId !== null) {
        try { await unloadModel({ modelId: this.#embeddingModelId }); this.#embeddingModelId = null; }
        catch (error) { failure = error; }
      }
      if (this.#generationModelId !== null) {
        try { await unloadModel({ modelId: this.#generationModelId }); this.#generationModelId = null; }
        catch (error) { if (failure === undefined) failure = error; }
      }
      try { await qvacClose(); } catch (error) { if (failure === undefined) failure = error; }
      if (failure !== undefined) throw failure;
      this.#closed = true;
    })();
    try { await this.#closing; } finally { this.#closing = null; }
  }
  #assertOpen(): void { if (this.#closed) throw new Error("QVAC runtime is closed"); }
}
