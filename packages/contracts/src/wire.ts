import Ajv2020Import from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import spaceStateSchema from "../schemas/space-state-v1.schema.json" with { type: "json" };
import { canonicalJson, decodeJson, encodeJson } from "./json.js";

export const LIMITS = { maxBodyBytes: 32_768, maxJsonDepth: 32, maxQueryBytes: 2_048, maxTtlSeconds: 86_400, maxPassages: 6, maxLeaseMs: 900_000 } as const;
export const IDSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const KeySchema = z.string().regex(/^[0-9a-f]{64}$/);
export const DigestSchema = KeySchema;
export const CapabilitySchema = z.enum(["search", "read", "share", "receive", "manage"]);
export type Capability = z.infer<typeof CapabilitySchema>;

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCounter = safeInteger.min(1);
const utf8AtMost = (bytes: number) => z.string().refine((value) => new TextEncoder().encode(value).byteLength <= bytes, `must contain at most ${bytes} UTF-8 bytes`);
export const PassageReferenceSchema = z.object({ originKey: KeySchema, documentId: IDSchema, versionId: IDSchema, spanId: IDSchema, startByte: safeInteger, endByte: safeInteger }).strict().refine(({ startByte, endByte }) => endByte > startByte, "endByte must be greater than startByte");
export const PassageSchema = z.object({ ref: PassageReferenceSchema, text: utf8AtMost(LIMITS.maxBodyBytes).min(1) }).strict().superRefine(({ ref, text }, context) => {
  if (new TextEncoder().encode(text).byteLength !== ref.endByte - ref.startByte) context.addIssue({ code: "custom", message: "passage text length must match UTF-8 byte offsets" });
});
export const ConditionsSchema = z.object({ v: z.literal(1), allowLocalSummary: z.boolean(), forwarding: z.literal("forbidden"), validForSeconds: z.number().int().min(1).max(86_400), notAfterMs: safeInteger.nullable() }).strict();

const base = { v: z.literal(1), requestId: IDSchema, spaceAlias: IDSchema };
export const SearchRequestSchema = z.object({ ...base, type: z.literal("SEARCH_REQUEST"), ttlSeconds: z.number().int().min(1).max(86_400), query: utf8AtMost(2_048).min(1), audienceKey: KeySchema }).strict();
export const ReceivedSchema = z.object({ ...base, type: z.literal("RECEIVED") }).strict();
export const ApprovedResponseSchema = z.object({ ...base, type: z.literal("APPROVED_RESPONSE"), responseId: IDSchema, passages: z.array(PassageSchema).min(1).max(6), conditions: ConditionsSchema }).strict().superRefine((message, context) => {
  const seen = new Set<string>();
  for (const passage of message.passages) {
    const key = referenceKey(passage.ref);
    if (seen.has(key)) context.addIssue({ code: "custom", message: "passage references must be unique" });
    seen.add(key);
  }
});
export const ResponseAckSchema = z.object({ ...base, type: z.literal("RESPONSE_ACK"), responseId: IDSchema, bodyDigest: DigestSchema }).strict();
export const ClosedSchema = z.object({ ...base, type: z.literal("CLOSED") }).strict();

export type PassageReference = z.infer<typeof PassageReferenceSchema>;
export type Passage = z.infer<typeof PassageSchema>;
export type ProcessingConditions = z.infer<typeof ConditionsSchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type Received = z.infer<typeof ReceivedSchema>;
export type ApprovedResponse = z.infer<typeof ApprovedResponseSchema>;
export type ResponseAck = z.infer<typeof ResponseAckSchema>;
export type Closed = z.infer<typeof ClosedSchema>;

export interface SpaceStateRequest { v: 1; type: "SPACE_STATE_REQUEST"; requestId: string; spaceAlias: string }
export interface SpaceMember { memberId: string; deviceKeys: string[]; capabilities: Capability[] }
export interface SpaceStateResponse { v: 1; type: "SPACE_STATE_RESPONSE"; requestId: string; spaceAlias: string; spaceId: string; authorityKey: string; recipientKey: string; policyRevision: number; publicationSeq: number; projectionScope: "recipient-authorized-peers-v1"; status: "ACTIVE" | "DENIED"; validForMs: number; members: SpaceMember[]; projectionDigest: string }
export type WireMessage = SearchRequest | Received | ApprovedResponse | ResponseAck | Closed | SpaceStateRequest | SpaceStateResponse;

const Ajv2020 = Ajv2020Import as unknown as new (options: { allErrors: boolean; strict: boolean }) => {
  compile(schema: object): ValidateFunction;
  errorsText(errors: unknown): string;
};
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSpaceState = ajv.compile(spaceStateSchema);

export function validateWire(value: unknown): WireMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Wire message must be an object");
  const type = (value as { type?: unknown }).type;
  if (type === "SPACE_STATE_REQUEST" || type === "SPACE_STATE_RESPONSE") {
    if (!validateSpaceState(value)) throw new Error("Invalid space-state message");
    validateSpaceStateSemantics(value as SpaceStateRequest | SpaceStateResponse);
    return value as SpaceStateRequest | SpaceStateResponse;
  }
  const schema = type === "SEARCH_REQUEST" ? SearchRequestSchema : type === "RECEIVED" ? ReceivedSchema : type === "APPROVED_RESPONSE" ? ApprovedResponseSchema : type === "RESPONSE_ACK" ? ResponseAckSchema : type === "CLOSED" ? ClosedSchema : undefined;
  if (!schema) throw new Error("Unsupported wire message type");
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid wire message: ${parsed.error.message}`);
  return parsed.data;
}

export function decodeWire(bytes: Uint8Array): WireMessage { return validateWire(decodeJson(bytes)); }
export function encodeWire(value: WireMessage): Uint8Array { validateWire(value); return encodeJson(value); }
export function digestBytes(bytes: Uint8Array): string { return bytesToHex(sha256(bytes)); }
export function canonicalDigest(value: unknown): string { return digestBytes(new TextEncoder().encode(canonicalJson(value))); }

export function projectionDigest(response: Omit<SpaceStateResponse, "projectionDigest"> | SpaceStateResponse): string {
  const state = {
    spaceId: response.spaceId, authorityKey: response.authorityKey, recipientKey: response.recipientKey,
    policyRevision: response.policyRevision, projectionScope: response.projectionScope, status: response.status,
    members: [...response.members].sort((a, b) => a.memberId.localeCompare(b.memberId)).map((member) => ({
      memberId: member.memberId,
      deviceKeys: [...member.deviceKeys].sort(),
      capabilities: [...member.capabilities].sort((a, b) => capabilityOrder(a) - capabilityOrder(b)),
    })),
  };
  return digestBytes(new TextEncoder().encode(JSON.stringify(state)));
}

export function referenceKey(ref: PassageReference): string { return `${ref.originKey}:${ref.documentId}:${ref.versionId}:${ref.spanId}:${ref.startByte}:${ref.endByte}`; }

function capabilityOrder(capability: Capability): number { return ["search", "read", "share", "receive", "manage"].indexOf(capability); }
function validateSpaceStateSemantics(message: SpaceStateRequest | SpaceStateResponse): void {
  if (message.type !== "SPACE_STATE_RESPONSE") return;
  const memberIds = new Set<string>();
  const deviceKeys = new Set<string>();
  for (const member of message.members) {
    if (memberIds.has(member.memberId)) throw new Error("Space-state members must have unique member IDs");
    memberIds.add(member.memberId);
    for (const key of member.deviceKeys) {
      if (deviceKeys.has(key)) throw new Error("Space-state members must have unique device keys");
      deviceKeys.add(key);
    }
  }
  if (message.status === "ACTIVE" && [...deviceKeys].filter((key) => key === message.recipientKey).length !== 1) throw new Error("Active space-state response must include recipient exactly once");
  if (projectionDigest(message) !== message.projectionDigest) throw new Error("Space-state projection digest does not match body");
}
