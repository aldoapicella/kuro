import { describe, expect, it } from "vitest";
import { QVAC_GENERATION_PROFILE, normalizeCompletionStopReason } from "../src/qvacClient.js";
import { ContextBudgetExceededError } from "../src/qvacClient.js";
import { prepareSummary, runPreparedSummary } from "../src/summary.js";
import { FakeQvacRuntime } from "../src/testing/fakeQvacRuntime.js";

const id = "a".repeat(32);
const prepared = () => prepareSummary({ jobId: id, preparationId: "c".repeat(32), deliveryId: "d".repeat(32), profile: QVAC_GENERATION_PROFILE, question: "Status?", passages: [{ ref: { originKey: "b".repeat(64), documentId: id, versionId: id, spanId: id, startByte: 0, endByte: 7 }, text: "Pending" }] });
describe("summary execution", () => {
  it("normalizes only the documented undefined natural-EOS SDK final reason", () => {
    expect(normalizeCompletionStopReason(undefined)).toBe("eos");
    expect(normalizeCompletionStopReason("eos")).toBe("eos");
    expect(normalizeCompletionStopReason("stopSequence")).toBe("stopSequence");
    expect(normalizeCompletionStopReason(null)).toBe("unknown");
    expect(normalizeCompletionStopReason("unexpected")).toBe("unknown");
  });
  it("returns current SummaryResult fields and leaves quote reconstruction to core", async () => {
    const result = await runPreparedSummary(new FakeQvacRuntime({ completionResponses: [JSON.stringify({ status: "answer", claims: [{ text: "Pending.", sourceAliases: ["P1"] }] })] }), prepared());
    expect(result).toEqual({ jobId: id, preparationDigest: prepared().digest, status: "answer", completion: "complete", claims: [{ text: "Pending.", sourceAliases: ["P1"] }] });
  });
  it("rejects malformed provider output", async () => {
    await expect(runPreparedSummary(new FakeQvacRuntime({ completionResponses: ["not json"] }), prepared())).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });
  it.each([
    ["unknown alias", { status: "answer", claims: [{ text: "x", sourceAliases: ["P2"] }] }],
    ["status claim mismatch", { status: "answer", claims: [] }],
    ["duplicate alias", { status: "answer", claims: [{ text: "x", sourceAliases: ["P1", "P1"] }] }],
    ["oversized claim", { status: "answer", claims: [{ text: "x".repeat(401), sourceAliases: ["P1"] }] }],
  ])("rejects %s from the provider", async (_name, output) => {
    await expect(runPreparedSummary(new FakeQvacRuntime({ completionResponses: [JSON.stringify(output)] }), prepared())).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });
  it("maps a genuine context overflow to capacity exceeded", async () => {
    await expect(runPreparedSummary(new FakeQvacRuntime({ completionError: new ContextBudgetExceededError() }), prepared())).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  });
  it("rejects a syntactically valid result truncated at the output limit", async () => {
    await expect(runPreparedSummary(new FakeQvacRuntime({ completionResponses: [JSON.stringify({ status: "insufficient", claims: [] })], completionStopReason: "length" }), prepared())).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  });
  it("fails closed when the backend does not provide a recognized terminal reason", async () => {
    await expect(runPreparedSummary(new FakeQvacRuntime({ completionResponses: [JSON.stringify({ status: "insufficient", claims: [] })], completionStopReason: "unknown" }), prepared())).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });
});
