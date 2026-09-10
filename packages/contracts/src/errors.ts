import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'ACCESS_DENIED', 'STALE_REVISION', 'MODEL_UNAVAILABLE', 'CAPACITY_EXCEEDED',
  'EXPIRED', 'PEER_OFFLINE', 'INVALID_MESSAGE', 'CANCELLED', 'STORAGE_FAILURE',
  'INVALID_MODEL_OUTPUT', 'INVALID_INPUT', 'CLOCK_UNCERTAIN', 'IDENTITY_UNAVAILABLE',
  'INCOMPLETE_INDEX', 'UNSUPPORTED_VERSION',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export const ErrorSchema = z.strictObject({ code: ErrorCodeSchema, retryable: z.boolean() });
export type PublicError = z.infer<typeof ErrorSchema>;
export type Result<T> = { ok: true; value: T } | { ok: false; error: PublicError };
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'PEER_OFFLINE', 'CAPACITY_EXCEEDED', 'STORAGE_FAILURE', 'MODEL_UNAVAILABLE',
  'CLOCK_UNCERTAIN', 'INCOMPLETE_INDEX',
]);
/** Public errors deliberately contain no payloads, SQL, local paths or model output. */
export class KuroError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'KuroError'; }
}
export const fail = (code: ErrorCode): never => { throw new KuroError(code); };
export const success = <T>(value: T): Result<T> => ({ ok: true, value });
export const failure = (code: ErrorCode): Result<never> => ({ ok: false, error: { code, retryable: RETRYABLE.has(code) } });
