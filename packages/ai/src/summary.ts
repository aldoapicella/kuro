import {
  GenerationProfileSchema,
  KuroError,
  PreparedSummarySchema,
  SummaryResultSchema,
  canonicalDigest,
  preparationDigest,
  summaryContext,
  validatePreparation,
  type GenerationProfile,
  type PreparedSummary,
  type SummaryPreparationInput,
  type SummaryResult,
} from "@kuro/contracts";
import { ContextBudgetExceededError, QVAC_GENERATION_PROFILE, type QvacRuntime } from "./qvacClient.js";

function sameProfile(profile: GenerationProfile): boolean { return canonicalDigest(profile) === canonicalDigest(QVAC_GENERATION_PROFILE); }
const byteLength = (value: string): number => new TextEncoder().encode(value).length;

export function buildSummarySchema(aliases: readonly string[]): Record<string, unknown> {
  return {
    type: "object", additionalProperties: false, required: ["status", "claims"], properties: {
      status: { enum: ["answer", "insufficient"] },
      claims: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["text", "sourceAliases"], properties: {
        text: { type: "string", minLength: 1, maxLength: 400 },
        sourceAliases: { type: "array", minItems: 1, maxItems: 4, items: { enum: [...aliases] } },
      } } },
    },
  };
}

/**
 * UTF-8 bytes bound tokenizer output from above for this exact JSON context.
 * It intentionally counts instructions, question, aliases, metadata and every
 * source byte, then reserves the profile's complete output allocation.
 */
export function prepareSummary(input: SummaryPreparationInput): PreparedSummary {
  try {
    GenerationProfileSchema.parse(input.profile);
    if (!sameProfile(input.profile)) throw new KuroError("MODEL_UNAVAILABLE");
    const sources: PreparedSummary["sources"] = [];
    const omittedReferences: PreparedSummary["omittedReferences"] = [];
    for (const passage of input.passages) {
      if (sources.length >= 6) { omittedReferences.push(passage.ref); continue; }
      const candidate = [...sources, { alias: `P${sources.length + 1}`, passage }];
      const context = summaryContext(input.question, candidate);
      if (byteLength(context) + input.profile.outputTokens <= input.profile.contextTokens) sources.push(candidate[candidate.length - 1]!);
      else omittedReferences.push(passage.ref);
    }
    if (sources.length === 0) throw new KuroError("CAPACITY_EXCEEDED");
    const context = summaryContext(input.question, sources);
    const body: Omit<PreparedSummary, "digest"> = {
      jobId: input.jobId, preparationId: input.preparationId, deliveryId: input.deliveryId, profile: input.profile,
      promptVersion: "kuro-summary-v1", schemaVersion: "kuro-claims-v1", question: input.question,
      questionDigest: canonicalDigest(input.question), sources, omittedReferences, context,
      contextTokens: byteLength(context), reservedOutputTokens: input.profile.outputTokens,
      tokenAccounting: "validated-byte-upper-bound",
    };
    return validatePreparation({ ...body, digest: preparationDigest(body) }, input);
  } catch (error) {
    if (error instanceof KuroError) throw error;
    throw new KuroError("INVALID_INPUT");
  }
}

function validateExecutionPreparation(value: PreparedSummary): PreparedSummary {
  try {
    const prepared = PreparedSummarySchema.parse(value);
    const { digest, ...body } = prepared;
    if (!sameProfile(prepared.profile) || digest !== preparationDigest(body) || prepared.context !== summaryContext(prepared.question, prepared.sources) || prepared.questionDigest !== canonicalDigest(prepared.question) || prepared.contextTokens !== byteLength(prepared.context) || prepared.contextTokens + prepared.reservedOutputTokens > prepared.profile.contextTokens || prepared.reservedOutputTokens !== prepared.profile.outputTokens || prepared.sources.some((source, index) => source.alias !== `P${index + 1}`)) throw new Error("manifest mismatch");
    return prepared;
  } catch { throw new KuroError("INVALID_MODEL_OUTPUT"); }
}

export async function runPreparedSummary(runtime: QvacRuntime, value: PreparedSummary): Promise<SummaryResult> {
  const prepared = validateExecutionPreparation(value);
  const schema = buildSummarySchema(prepared.sources.map((source) => source.alias));
  let outcome;
  try {
    outcome = await runtime.withExclusiveOperation(prepared.jobId, async () => {
      const modelId = await runtime.ensureGenerationModelLoaded();
      runtime.throwIfCancelled();
      return runtime.runCompletion({ modelId, context: prepared.context, outputTokens: prepared.reservedOutputTokens, schema });
    });
  } catch (error) {
    if (error instanceof KuroError) throw error;
    if (error instanceof ContextBudgetExceededError) throw new KuroError("CAPACITY_EXCEEDED");
    throw new KuroError("MODEL_UNAVAILABLE");
  }
  if (outcome.kind === "busy") throw new KuroError("CAPACITY_EXCEEDED");
  if (outcome.kind === "cancelled") throw new KuroError("CANCELLED");
  if (outcome.value.stopReason === "length") throw new KuroError("CAPACITY_EXCEEDED");
  if (outcome.value.stopReason === "cancelled") throw new KuroError("CANCELLED");
  if (outcome.value.stopReason === "error") throw new KuroError("MODEL_UNAVAILABLE");
  if (outcome.value.stopReason === "unknown") throw new KuroError("INVALID_MODEL_OUTPUT");
  try {
    const model = JSON.parse(outcome.value.contentText) as unknown;
    if (model === null || typeof model !== "object" || Array.isArray(model) || Object.keys(model).some((key) => key !== "status" && key !== "claims")) throw new Error("model output is not the claims object");
    const raw = model as { status: unknown; claims: unknown };
    const result = SummaryResultSchema.parse({ jobId: prepared.jobId, preparationDigest: prepared.digest, completion: "complete", status: raw.status, claims: raw.claims });
    const aliases = new Set(prepared.sources.map((source) => source.alias));
    if (result.claims.some((claim) => claim.sourceAliases.some((alias) => !aliases.has(alias)))) throw new Error("unknown source alias");
    return result;
  } catch { throw new KuroError("INVALID_MODEL_OUTPUT"); }
}
