import { BlockSchema, IDSchema, KuroError, ModelProfileSchema, canonicalDigest, validateVectors, type EmbeddingResult, type ModelProfile } from "@kuro/contracts";
import { QVAC_EMBEDDING_PROFILE, type QvacRuntime } from "./qvacClient.js";

function pinned(profile: ModelProfile): boolean { return canonicalDigest(profile) === canonicalDigest(QVAC_EMBEDDING_PROFILE); }
function normalize(values: readonly number[]): number[] {
  const float = Float32Array.from(values);
  const norm = Math.hypot(...float);
  if (!float.every(Number.isFinite) || !(norm > 0)) throw new KuroError("INVALID_MODEL_OUTPUT");
  return Array.from(Float32Array.from(float, (value) => value / norm));
}
export async function embedBlocks(runtime: QvacRuntime, input: { jobId: string; profile: ModelProfile; blocks: { id: string; text: string; ref: unknown | null }[] }): Promise<EmbeddingResult> {
  try {
    IDSchema.parse(input.jobId); ModelProfileSchema.parse(input.profile);
    if (!Array.isArray(input.blocks) || input.blocks.length < 1 || input.blocks.length > 4) throw new Error("invalid blocks");
    input.blocks.forEach((block) => BlockSchema.parse(block));
  } catch { throw new KuroError("INVALID_INPUT"); }
  if (!pinned(input.profile)) throw new KuroError("MODEL_UNAVAILABLE");
  if (new Set(input.blocks.map((block) => block.id)).size !== input.blocks.length) throw new KuroError("INVALID_INPUT");
  let outcome;
  try {
    outcome = await runtime.withExclusiveOperation(input.jobId, async () => {
      const modelId = await runtime.ensureEmbeddingModelLoaded();
      runtime.throwIfCancelled();
      return runtime.embedTexts(modelId, input.blocks.map((block) => block.text));
    });
  } catch (error) { if (error instanceof KuroError) throw error; throw new KuroError("MODEL_UNAVAILABLE"); }
  if (outcome.kind === "busy") throw new KuroError("CAPACITY_EXCEEDED");
  if (outcome.kind === "cancelled") throw new KuroError("CANCELLED");
  try {
    if (outcome.value.length !== input.blocks.length) throw new KuroError("INVALID_MODEL_OUTPUT");
    return validateVectors({ jobId: input.jobId, profile: input.profile, vectors: input.blocks.map((block, index) => ({ id: block.id, values: normalize(outcome.value[index] ?? []) })) }, input.jobId, input.profile, input.blocks.map((block) => block.id));
  } catch (error) { if (error instanceof KuroError) throw error; throw new KuroError("INVALID_MODEL_OUTPUT"); }
}
