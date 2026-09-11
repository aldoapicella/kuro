import { from, isUtf8 } from 'bare-buffer';

export interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

export interface TextDecodeOptions {
  stream?: boolean;
}

/**
 * The subset of WHATWG text encoding needed by the bundled KURO contracts.
 * Bare does not provide the global interfaces, so this adapter keeps the
 * contract's strict UTF-8 validation while delegating encoding/decoding to
 * bare-buffer's native implementation.
 */
export class TextEncoder {
  readonly encoding = 'utf-8';

  encode(input = ''): Uint8Array {
    return from(String(input));
  }
}

export class TextDecoder {
  readonly encoding = 'utf-8';
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;

  constructor(label = 'utf-8', options: TextDecoderOptions = {}) {
    if (!isUtf8Label(label)) throw new RangeError(`The encoding label '${label}' is not supported`);
    this.fatal = options.fatal === true;
    this.ignoreBOM = options.ignoreBOM === true;
  }

  decode(input?: ArrayBufferLike | ArrayBufferView, options: TextDecodeOptions = {}): string {
    if (options.stream === true) throw new TypeError('Streaming TextDecoder is not supported in Bare');
    const bytes = asBytes(input);
    if (this.fatal && !isUtf8(bytes)) throw new TypeError('The input is not valid UTF-8');
    const decoded = from(bytes).toString('utf8');
    return this.ignoreBOM || decoded.charCodeAt(0) !== 0xfeff ? decoded : decoded.slice(1);
  }
}

function isUtf8Label(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized === 'unicode-1-1-utf-8' || normalized === 'unicode11utf8' || normalized === 'unicode20utf8' || normalized === 'utf-8' || normalized === 'utf8' || normalized === 'x-unicode20utf8';
}

function asBytes(input: ArrayBufferLike | ArrayBufferView | undefined): Uint8Array {
  if (input === undefined) return new Uint8Array(0);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}
