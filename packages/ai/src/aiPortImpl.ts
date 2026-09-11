import type { AiPort } from "@kuro/contracts";
import { KuroError } from "@kuro/contracts";
import { getCapabilities } from "./capabilities.js";
import { embedBlocks } from "./embedding.js";
import { QvacClient, type QvacRuntime } from "./qvacClient.js";
import { rankAllowed } from "./ranking.js";
import { prepareSummary, runPreparedSummary } from "./summary.js";

function asKuroError(error: unknown): KuroError { return error instanceof KuroError ? error : new KuroError("MODEL_UNAVAILABLE"); }
function portFor(runtime: QvacRuntime): AiPort {
  return {
    getCapabilities: async () => getCapabilities(runtime),
    embedBlocks: async (input) => { try { return await embedBlocks(runtime, input); } catch (error) { throw asKuroError(error); } },
    rankAllowed: async (input) => { try { return rankAllowed(input); } catch (error) { throw asKuroError(error); } },
    prepareSummary: async (input) => { try { return prepareSummary(input); } catch (error) { throw asKuroError(error); } },
    runPreparedSummary: async (preparation) => { try { return await runPreparedSummary(runtime, preparation); } catch (error) { throw asKuroError(error); } },
    cancel: async (jobId) => { try { await runtime.cancel(jobId); } catch (error) { throw asKuroError(error); } },
  };
}
/** Host-owned lifecycle is deliberately outside AiPort's fixed public contract. */
export interface AiAdapter { readonly port: AiPort; close(): Promise<void>; }
export function createAiAdapter(runtime: QvacRuntime = new QvacClient()): AiAdapter { return { port: portFor(runtime), close: () => runtime.close() }; }
export function createAiPort(runtime: QvacRuntime = new QvacClient()): AiPort { return portFor(runtime); }
export { QvacClient };
export type { QvacRuntime };
