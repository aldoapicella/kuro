export { createAiAdapter, createAiPort, QvacClient, type AiAdapter, type QvacRuntime } from "./aiPortImpl.js";
export { QVAC_EMBEDDING_PROFILE, QVAC_GENERATION_PROFILE, EMBEDDING_FALLBACK_SRC, GENERATION_FALLBACK_SRC, ContextBudgetExceededError, normalizeCompletionStopReason, type CompletionOutcome, type CompletionRequest, type CompletionStopReason, type QvacClientOptions } from "./qvacClient.js";
export { cosineSimilarity, rankAllowed } from "./ranking.js";
export { embedBlocks } from "./embedding.js";
export { buildSummarySchema, prepareSummary, runPreparedSummary } from "./summary.js";
export { ExecutionGuard, type ExclusiveOutcome } from "./executionGuard.js";
