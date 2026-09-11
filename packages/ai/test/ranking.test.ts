import { describe, expect, it } from "vitest";
import { KuroError } from "@kuro/contracts";
import { cosineSimilarity, rankAllowed } from "../src/ranking.js";

const profile = { modelId: "synthetic", modelChecksum: "a".repeat(64), dimension: 2, normalization: "none" as const, segmentationVersion: "v1" };
describe("pure ranking", () => {
  it("scores cosine similarity and resolves ties by id", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    const output = rankAllowed({ jobId: "b".repeat(32), profile, query: { id: "c".repeat(32), values: [1, 0] }, candidates: [{ id: "e".repeat(32), values: [0, 1] }, { id: "d".repeat(32), values: [0, 1] }], limit: 2 });
    expect(output.ranked.map((entry) => entry.id)).toEqual(["d".repeat(32), "e".repeat(32)]);
  });
  it("rejects malformed vectors rather than silently changing the supplied candidate set", () => {
    expect(() => rankAllowed({ jobId: "b".repeat(32), profile, query: { id: "c".repeat(32), values: [0, 0] }, candidates: [], limit: 1 })).toThrow(KuroError);
  });
  it("rejects non-finite candidates and invalid limits", () => {
    expect(() => rankAllowed({ jobId: "b".repeat(32), profile, query: { id: "c".repeat(32), values: [1, 0] }, candidates: [{ id: "d".repeat(32), values: [Number.NaN, 0] }], limit: 1 })).toThrow(KuroError);
    expect(() => rankAllowed({ jobId: "b".repeat(32), profile, query: { id: "c".repeat(32), values: [1, 0] }, candidates: [], limit: 0 })).toThrow(KuroError);
  });
});
