import { KuroError, RankResultSchema, type ModelProfile, type RankResult } from "@kuro/contracts";

function valid(values: readonly number[], dimension: number): boolean { return values.length === dimension && values.every(Number.isFinite) && Math.hypot(...values) > 0; }
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !valid(a, a.length) || !valid(b, b.length)) throw new KuroError("INVALID_INPUT");
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index]! * b[index]!;
  return dot / (Math.hypot(...a) * Math.hypot(...b));
}
/** Pure scoring over only the pre-authorized candidate vectors provided by core. */
export function rankAllowed(input: { jobId: string; profile: ModelProfile; query: { id: string; values: number[] }; candidates: { id: string; values: number[] }[]; limit: number }): RankResult {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 40 || !valid(input.query.values, input.profile.dimension)) throw new KuroError("INVALID_INPUT");
  const seen = new Set<string>();
  const ranked = input.candidates.map((candidate) => {
    if (seen.has(candidate.id) || !valid(candidate.values, input.profile.dimension)) throw new KuroError("INVALID_INPUT");
    seen.add(candidate.id);
    return { id: candidate.id, score: cosineSimilarity(input.query.values, candidate.values) };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, input.limit);
  return RankResultSchema.parse({ jobId: input.jobId, ranked });
}
