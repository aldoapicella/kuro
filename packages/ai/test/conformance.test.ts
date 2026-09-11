import { describe, expect, it } from "vitest";
import { KuroError, preparationDigest, summaryContext, validatePreparation, type AiPort, type Passage, type SummaryPreparationInput } from "@kuro/contracts";
import { createAiAdapter, createAiPort } from "../src/aiPortImpl.js";
import { QVAC_EMBEDDING_PROFILE, QVAC_GENERATION_PROFILE } from "../src/qvacClient.js";
import { FakeAiPort } from "../src/testing/fakeAiPort.js";
import { FakeQvacRuntime } from "../src/testing/fakeQvacRuntime.js";

const id = "a".repeat(32);
const ref = { originKey: "b".repeat(64), documentId: id, versionId: id, spanId: id, startByte: 0, endByte: 7 };
const passage: Passage = { ref, text: "Pending" };
const input = (): SummaryPreparationInput => ({ jobId: id, preparationId: "c".repeat(32), deliveryId: "d".repeat(32), profile: QVAC_GENERATION_PROFILE, question: "Status?", passages: [passage] });

describe("AiPort contract migration", () => {
  it.each([
    ["explicit fake", () => new FakeAiPort()],
    ["scripted real adapter", () => createAiPort(new FakeQvacRuntime())],
  ])("keeps the same observable AiPort structure for %s", async (_name, make) => {
    const port: AiPort = make();
    const embedding = await port.embedBlocks({ jobId: id, profile: QVAC_EMBEDDING_PROFILE, blocks: [{ id, text: "approved evidence", ref: null }] });
    const prepared = await port.prepareSummary(input());
    const summary = await port.runPreparedSummary(prepared);
    expect(embedding.vectors[0]!.id).toBe(id);
    expect(summary).toMatchObject({ jobId: id, preparationDigest: prepared.digest, completion: "complete", status: "insufficient", claims: [] });
  });
  it("has the exact structural AiPort surface and published registry profiles", async () => {
    const port: AiPort = createAiPort(new FakeQvacRuntime());
    expect(await port.getCapabilities()).toEqual({ provider: "simulated", embeddingProfiles: [QVAC_EMBEDDING_PROFILE], generationProfiles: [QVAC_GENERATION_PROFILE], available: true });
    expect(QVAC_EMBEDDING_PROFILE.modelChecksum).toBe("939f1fb3fcc70f2a250a7e7ad7c2fbdc1397d46f9a8055d053e451829c5293fb");
    expect(QVAC_GENERATION_PROFILE.modelChecksum).toBe("c876f159707a4e4f70e045106c69db15bfc935a4981706fd4f65c6e7ea1e81c5");
  });

  it("returns Float32 unit vectors with exact profile identity", async () => {
    const port = createAiPort(new FakeQvacRuntime());
    const result = await port.embedBlocks({ jobId: id, profile: QVAC_EMBEDDING_PROFILE, blocks: [{ id, text: "approved evidence", ref: null }] });
    expect(result.profile).toEqual(QVAC_EMBEDDING_PROFILE);
    expect(result.vectors[0]!.values).toHaveLength(1024);
    expect(Math.hypot(...result.vectors[0]!.values)).toBeCloseTo(1, 4);
    await expect(port.embedBlocks({ jobId: id, profile: { ...QVAC_EMBEDDING_PROFILE, modelChecksum: "0".repeat(64) }, blocks: [{ id, text: "x", ref: null }] })).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" } satisfies Partial<KuroError>);
  });

  it.each([
    ["wrong output count", []],
    ["extra output", [Array.from({ length: 1024 }, () => 1), Array.from({ length: 1024 }, () => 1)]],
    ["wrong dimension", [[1, 0]]],
    ["nonfinite component", [[Number.POSITIVE_INFINITY, 0, 0]]],
    ["zero norm", [[0, 0, 0]]],
  ])("rejects provider embeddings with %s", async (_name, embeddingVectors) => {
    const port = createAiPort(new FakeQvacRuntime({ embeddingVectors }));
    await expect(port.embedBlocks({ jobId: id, profile: QVAC_EMBEDDING_PROFILE, blocks: [{ id, text: "evidence", ref: null }] })).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });

  it("enforces bounded and identified embedding batches", async () => {
    const port = createAiPort(new FakeQvacRuntime());
    await expect(port.embedBlocks({ jobId: id, profile: QVAC_EMBEDDING_PROFILE, blocks: Array.from({ length: 5 }, (_, index) => ({ id: `${index}`.padStart(32, "0"), text: "evidence", ref: null })) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(port.embedBlocks({ jobId: id, profile: QVAC_EMBEDDING_PROFILE, blocks: [{ id, text: "one", ref: null }, { id, text: "two", ref: null }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(port.embedBlocks({ jobId: "not-an-id", profile: QVAC_EMBEDDING_PROFILE, blocks: [{ id, text: "one", ref: null }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(port.embedBlocks({ jobId: id, profile: QVAC_EMBEDDING_PROFILE, blocks: [{ id, text: "", ref: null }] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("keeps ranking pure over its supplied vectors", async () => {
    const port = createAiPort(new FakeQvacRuntime());
    const profile = { modelId: "synthetic", modelChecksum: "0".repeat(64), dimension: 3, normalization: "none" as const, segmentationVersion: "v1" };
    const result = await port.rankAllowed({ jobId: id, profile, query: { id, values: [1, 0, 0] }, candidates: [{ id: "c".repeat(32), values: [0, 1, 0] }, { id: "d".repeat(32), values: [1, 0, 0] }], limit: 2 });
    expect(result.ranked.map((item) => item.id)).toEqual(["d".repeat(32), "c".repeat(32)]);
  });

  it("prepares complete provenance and rejects text or alias tampering before execution", async () => {
    const runtime = new FakeQvacRuntime({ completionResponses: [JSON.stringify({ status: "answer", claims: [{ text: "It remains pending.", sourceAliases: ["P1"] }] })] });
    const port = createAiPort(runtime);
    const prepared = await port.prepareSummary(input());
    expect(prepared.sources).toEqual([{ alias: "P1", passage }]);
    const aliasSources = [{ ...prepared.sources[0]!, alias: "P2" }];
    const { digest: _aliasDigest, ...aliasBody } = { ...prepared, sources: aliasSources, context: summaryContext(prepared.question, aliasSources) };
    const aliasTampered = { ...aliasBody, digest: preparationDigest(aliasBody) };
    await expect(port.runPreparedSummary(aliasTampered)).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    const textSources = [{ ...prepared.sources[0]!, passage: { ...passage, text: "Forged!" } }];
    const { digest: _textDigest, ...textBody } = { ...prepared, sources: textSources, context: summaryContext(prepared.question, textSources) };
    const textTampered = { ...textBody, digest: preparationDigest(textBody) };
    expect(() => validatePreparation(textTampered, input())).toThrow();
    expect(runtime.calls.runCompletion).toBe(0);
    expect(await port.runPreparedSummary(prepared)).toMatchObject({ jobId: id, preparationDigest: prepared.digest, completion: "complete" });
  });

  it("does not let raw model JSON overwrite trusted result correlation fields", async () => {
    const port = createAiPort(new FakeQvacRuntime({ completionResponses: [JSON.stringify({ jobId: "e".repeat(32), preparationDigest: "f".repeat(64), status: "insufficient", claims: [] })] }));
    await expect(port.runPreparedSummary(await port.prepareSummary(input()))).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });

  it("exposes a host-close lifecycle without adding it to AiPort", async () => {
    const runtime = new FakeQvacRuntime();
    const adapter = createAiAdapter(runtime);
    await adapter.close();
    await adapter.close();
    expect(runtime.calls.close).toBe(1);
  });
});
