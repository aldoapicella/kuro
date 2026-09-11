import { describe, expect, it } from "vitest";
import { KuroError, validatePreparation } from "@kuro/contracts";
import { QVAC_GENERATION_PROFILE } from "../src/qvacClient.js";
import { prepareSummary } from "../src/summary.js";

const id = "a".repeat(32);
const passage = (spanId: string, text: string) => ({ ref: { originKey: "b".repeat(64), documentId: id, versionId: id, spanId, startByte: 0, endByte: new TextEncoder().encode(text).length }, text });
describe("summary preparation", () => {
  it("uses a conservative UTF-8 bound for the entire exact context and records omissions", () => {
    const input = { jobId: id, preparationId: "c".repeat(32), deliveryId: "d".repeat(32), profile: QVAC_GENERATION_PROFILE, question: "Status?", passages: [passage(id, "Pending"), passage("e".repeat(32), "x".repeat(5000))] };
    const prepared = prepareSummary(input);
    expect(prepared.contextTokens).toBe(new TextEncoder().encode(prepared.context).length);
    expect(prepared.contextTokens + prepared.reservedOutputTokens).toBeLessThanOrEqual(prepared.profile.contextTokens);
    expect(prepared.omittedReferences).toHaveLength(1);
    expect(validatePreparation(prepared, input)).toEqual(prepared);
  });
  it("rejects a profile with a mismatched pinned checksum", () => {
    expect(() => prepareSummary({ jobId: id, preparationId: "c".repeat(32), deliveryId: "d".repeat(32), profile: { ...QVAC_GENERATION_PROFILE, modelChecksum: "0".repeat(64) }, question: "Status?", passages: [passage(id, "Pending")] })).toThrow(KuroError);
  });
});
