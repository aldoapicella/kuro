import type { AiPort } from "@kuro/contracts";
import { createAiAdapter } from "../aiPortImpl.js";
import { FakeQvacRuntime, type FakeQvacScript } from "./fakeQvacRuntime.js";
/** Explicit simulated port for consumers; it is never selected by a real-adapter failure. */
export class FakeAiPort implements AiPort {
  readonly #adapter: ReturnType<typeof createAiAdapter>;
  constructor(script: FakeQvacScript = {}) { this.#adapter = createAiAdapter(new FakeQvacRuntime(script)); }
  async getCapabilities() { return this.#adapter.port.getCapabilities(); }
  async embedBlocks(input: Parameters<AiPort["embedBlocks"]>[0]) { return this.#adapter.port.embedBlocks(input); }
  async rankAllowed(input: Parameters<AiPort["rankAllowed"]>[0]) { return this.#adapter.port.rankAllowed(input); }
  async prepareSummary(input: Parameters<AiPort["prepareSummary"]>[0]) { return this.#adapter.port.prepareSummary(input); }
  async runPreparedSummary(preparation: Parameters<AiPort["runPreparedSummary"]>[0]) { return this.#adapter.port.runPreparedSummary(preparation); }
  async cancel(jobId: string) { return this.#adapter.port.cancel(jobId); }
  close(): Promise<void> { return this.#adapter.close(); }
}
