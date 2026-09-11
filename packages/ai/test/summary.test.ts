import { describe, expect, it } from "vitest";
import { KuroError, validatePreparation } from "@kuro/contracts";
import { QVAC_GENERATION_PROFILE } from "../src/qvacClient.js";
import { buildSummarySchema, prepareSummary } from "../src/summary.js";

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

describe("constrained decoding schema", () => {
  // Whatever this schema admits, the provider can emit. A single status enum let
  // the grammar produce {"status":"answer","claims":[]}, which SummaryResultSchema
  // then rejects as INVALID_MODEL_OUTPUT — so each status must pin its claim count.
  type Branch = { properties: { status: { const: string }; claims: { minItems?: number; maxItems?: number; items: { properties: { sourceAliases: { items: { enum: string[] } } } } } } };
  const schema = buildSummarySchema(["P1", "P2"]) as unknown as { anyOf: Branch[] };
  const branch = (status: string) => schema.anyOf.find((entry) => entry.properties.status.const === status);
  it("requires at least one claim on an answer", () => {
    expect(branch("answer")?.properties.claims).toMatchObject({ minItems: 1, maxItems: 4 });
  });
  it("forbids every claim on an insufficient result", () => {
    expect(branch("insufficient")?.properties.claims.maxItems).toBe(0);
  });
  it("offers no status beyond the two the contract defines", () => {
    expect(schema.anyOf.map((entry) => entry.properties.status.const).sort()).toEqual(["answer", "insufficient"]);
  });
  it("restricts citations to the prepared aliases", () => {
    expect(branch("answer")?.properties.claims.items.properties.sourceAliases.items.enum).toEqual(["P1", "P2"]);
  });
});
