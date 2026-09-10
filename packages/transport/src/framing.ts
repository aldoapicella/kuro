import { LIMITS, decodeWire } from '@kuro/contracts';

export const FRAME_PREFIX_BYTES = 4;
export const MAX_FRAME_BYTES = FRAME_PREFIX_BYTES + LIMITS.maxBodyBytes;

/** Creates a KURO frame after checking the exact body against the shared wire schema. */
export function encodeFrame(body: Uint8Array): Uint8Array {
  validateBody(body);
  const frame = new Uint8Array(FRAME_PREFIX_BYTES + body.byteLength);
  new DataView(frame.buffer, frame.byteOffset, FRAME_PREFIX_BYTES).setUint32(0, body.byteLength, false);
  frame.set(body, FRAME_PREFIX_BYTES);
  return frame;
}

/** Validates exact bytes without re-encoding them, preserving retry/digest semantics. */
export function validateBody(body: Uint8Array): void {
  if (body.byteLength === 0 || body.byteLength > LIMITS.maxBodyBytes) throw new Error('Invalid transport body length');
  decodeWire(body);
}

/**
 * Bounded accumulator for stream chunks. A declared oversized body is rejected before a body-sized
 * allocation occurs. The caller validates each returned exact body with `validateBody`.
 */
export class FrameDecoder {
  #buffer = new Uint8Array(0);

  constructor(private readonly maxBufferedBytes = MAX_FRAME_BYTES * 4) {
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < MAX_FRAME_BYTES) {
      throw new Error('Invalid frame buffer limit');
    }
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) return [];
    if (chunk.byteLength > this.maxBufferedBytes - this.#buffer.byteLength) {
      throw new Error('Transport receive buffer limit exceeded');
    }
    const joined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.byteLength);
    this.#buffer = joined;

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (this.#buffer.byteLength - offset >= FRAME_PREFIX_BYTES) {
      const length = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + offset, FRAME_PREFIX_BYTES).getUint32(0, false);
      if (length === 0 || length > LIMITS.maxBodyBytes) throw new Error('Invalid framed body length');
      const end = offset + FRAME_PREFIX_BYTES + length;
      if (end > this.#buffer.byteLength) break;
      frames.push(this.#buffer.slice(offset + FRAME_PREFIX_BYTES, end));
      offset = end;
    }
    this.#buffer = this.#buffer.slice(offset);
    return frames;
  }

  get bufferedBytes(): number { return this.#buffer.byteLength; }
}
