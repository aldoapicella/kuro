/** Strict, bounded JSON helpers shared by portable protocol implementations. */

export const MAX_JSON_BYTES = 32_768;
export const MAX_JSON_DEPTH = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error("JSON body exceeds 32768 bytes");
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    throw new Error("JSON body is not valid UTF-8");
  }
  return new Parser(source).parse();
}

export function encodeJson(value: unknown): Uint8Array {
  const bytes = encoder.encode(canonicalJson(value));
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error("JSON body exceeds 32768 bytes");
  return bytes;
}

/** Stable JSON with recursively sorted object properties. */
export function canonicalJson(value: unknown): string {
  return canonical(value, 0);
}

function canonical(value: unknown, depth: number): string {
  if (depth > MAX_JSON_DEPTH) throw new Error("JSON nesting exceeds 32");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    requireValidString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  if (typeof value !== "object") throw new Error("Value is not JSON");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${canonical(key, depth + 1)}:${canonical(object[key], depth + 1)}`).join(",")}}`;
}

function requireValidString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (low >= 0xdc00 && low <= 0xdfff) continue;
      throw new Error("JSON strings must not contain lone surrogates");
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("JSON strings must not contain lone surrogates");
  }
}

class Parser {
  #index = 0;
  constructor(private readonly source: string) {}

  parse(): unknown {
    this.space();
    const value = this.value(0);
    this.space();
    if (this.#index !== this.source.length) this.fail("unexpected trailing data");
    return value;
  }

  private value(depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) this.fail("JSON nesting exceeds 32");
    switch (this.source[this.#index]) {
      case "{": return this.object(depth + 1);
      case "[": return this.array(depth + 1);
      case "\"": return this.string();
      case "t": return this.literal("true", true);
      case "f": return this.literal("false", false);
      case "n": return this.literal("null", null);
      default: return this.number();
    }
  }

  private object(depth: number): Record<string, unknown> {
    this.#index++;
    this.space();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (this.take("}")) return result;
    while (true) {
      this.space();
      if (this.source[this.#index] !== "\"") this.fail("object key must be a string");
      const key = this.string();
      if (keys.has(key)) this.fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.space();
      if (!this.take(":")) this.fail("expected colon");
      this.space();
      result[key] = this.value(depth);
      this.space();
      if (this.take("}")) return result;
      if (!this.take(",")) this.fail("expected comma");
    }
  }

  private array(depth: number): unknown[] {
    this.#index++;
    this.space();
    const result: unknown[] = [];
    if (this.take("]")) return result;
    while (true) {
      this.space();
      result.push(this.value(depth));
      this.space();
      if (this.take("]")) return result;
      if (!this.take(",")) this.fail("expected comma");
    }
  }

  private string(): string {
    this.#index++;
    let result = "";
    while (this.#index < this.source.length) {
      const char = this.source[this.#index++];
      if (char === undefined) this.fail("unterminated string");
      if (char === "\"") return result;
      if (char === "\\") {
        const escaped = this.source[this.#index++];
        if (escaped === undefined) this.fail("unterminated escape");
        const simple: Record<string, string> = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (escaped in simple) { result += simple[escaped]; continue; }
        if (escaped !== "u") this.fail("invalid escape");
        result += this.unicodeEscape();
        continue;
      }
      if (char < " ") this.fail("invalid string character");
      const unit = char.charCodeAt(0);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = this.source[this.#index];
        if (low === undefined || low.charCodeAt(0) < 0xdc00 || low.charCodeAt(0) > 0xdfff) this.fail("lone high surrogate");
        result += char + low;
        this.#index++;
        continue;
      }
      if (unit >= 0xdc00 && unit <= 0xdfff) this.fail("lone low surrogate");
      result += char;
    }
    this.fail("unterminated string");
  }

  private unicodeEscape(): string {
    const unit = this.hexUnit();
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (this.source.slice(this.#index, this.#index + 2) !== "\\u") this.fail("lone high surrogate");
      this.#index += 2;
      const low = this.hexUnit();
      if (low < 0xdc00 || low > 0xdfff) this.fail("invalid surrogate pair");
      return String.fromCharCode(unit, low);
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) this.fail("lone low surrogate");
    return String.fromCharCode(unit);
  }

  private hexUnit(): number {
    const text = this.source.slice(this.#index, this.#index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(text)) this.fail("invalid unicode escape");
    this.#index += 4;
    return Number.parseInt(text, 16);
  }

  private number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.#index));
    if (!match) this.fail("invalid value");
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("number is not finite");
    return value;
  }

  private literal(text: string, value: unknown): unknown {
    if (this.source.slice(this.#index, this.#index + text.length) !== text) this.fail("invalid literal");
    this.#index += text.length;
    return value;
  }
  private take(character: string): boolean { if (this.source[this.#index] === character) { this.#index++; return true; } return false; }
  private space(): void {
    while ([" ", "\t", "\n", "\r"].includes(this.source[this.#index] ?? "")) this.#index++;
  }
  private fail(message: string): never { throw new Error(`Invalid JSON: ${message}`); }
}
