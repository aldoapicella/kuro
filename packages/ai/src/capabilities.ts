import type { AiCapabilities } from "@kuro/contracts";
import { QVAC_EMBEDDING_PROFILE, QVAC_GENERATION_PROFILE, type QvacRuntime } from "./qvacClient.js";
export function getCapabilities(runtime: QvacRuntime): AiCapabilities {
  return runtime.provider === "qvac"
    ? { provider: "qvac", embeddingProfiles: [QVAC_EMBEDDING_PROFILE], generationProfiles: [QVAC_GENERATION_PROFILE], available: true }
    : { provider: "simulated", embeddingProfiles: [QVAC_EMBEDDING_PROFILE], generationProfiles: [QVAC_GENERATION_PROFILE], available: true };
}
