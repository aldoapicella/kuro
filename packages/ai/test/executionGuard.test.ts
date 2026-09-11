import { describe, expect, it } from "vitest";
import { createAiPort } from "../src/aiPortImpl.js";
import { ExecutionGuard } from "../src/executionGuard.js";
import { QVAC_EMBEDDING_PROFILE, QVAC_GENERATION_PROFILE } from "../src/qvacClient.js";
import { FakeQvacRuntime } from "../src/testing/fakeQvacRuntime.js";

const id = "a".repeat(32);
const preparation = () => ({ jobId: id, preparationId: "c".repeat(32), deliveryId: "d".repeat(32), profile: QVAC_GENERATION_PROFILE, question: "Status?", passages: [{ ref: { originKey: "b".repeat(64), documentId: id, versionId: id, spanId: id, startByte: 0, endByte: 7 }, text: "Pending" }] });

describe("cancellation guard", () => {
  it("retains the cancelled slot until a provider that rejected cancel settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new FakeQvacRuntime({ completionGate: gate, cancelError: new Error("provider unavailable") });
    const port = createAiPort(runtime);
    const prepared = await port.prepareSummary(preparation());
    const running = port.runPreparedSummary(prepared);
    await Promise.resolve();
    await expect(port.cancel(id)).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    await expect(port.embedBlocks({ jobId: "e".repeat(32), profile: QVAC_EMBEDDING_PROFILE, blocks: [{ id: "f".repeat(32), text: "x", ref: null }] })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(runtime.activeJobId).toBe(id);
    release();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(runtime.activeJobId).toBeNull();
  });

  it("releases after backend failure and ignores cancellation for another job", async () => {
    const guard = new ExecutionGuard();
    await expect(guard.run(id, async () => { throw new Error("backend failed"); })).rejects.toThrow("backend failed");
    expect(guard.activeJobId).toBeNull();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = guard.run(id, async () => { await gate; return "done"; });
    expect(guard.markCancelled("b".repeat(32))).toBe(false);
    release();
    await expect(running).resolves.toEqual({ kind: "done", value: "done" });
    expect(guard.activeJobId).toBeNull();
  });

  it.each([
    ["embedding"],
    ["generation"],
  ])("cancelling during a cold %s load prevents later model computation", async (kind) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const script = kind === "embedding" ? { embeddingLoadGate: gate } : { generationLoadGate: gate };
    const runtime = new FakeQvacRuntime(script);
    const port = createAiPort(runtime);
    const running = kind === "embedding"
      ? port.embedBlocks({ jobId: id, profile: QVAC_EMBEDDING_PROFILE, blocks: [{ id: "f".repeat(32), text: "evidence", ref: null }] })
      : port.runPreparedSummary(await port.prepareSummary(preparation()));
    await Promise.resolve();
    await port.cancel(id);
    expect(runtime.activeJobId).toBe(id);
    release();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(kind === "embedding" ? runtime.calls.embedTexts : runtime.calls.runCompletion).toBe(0);
    expect(runtime.activeJobId).toBeNull();
  });
});
