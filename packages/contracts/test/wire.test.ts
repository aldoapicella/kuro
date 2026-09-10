import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeJson } from "../src/json.js";
import { canonicalDigest, decodeWire, digestBytes, encodeWire, projectionDigest, validateWire } from "../src/wire.js";

const text = new TextDecoder();
const root = new URL("../../../", import.meta.url);
const fixture = (path: string) => readFile(new URL(`fixtures/contracts/v1/${path}`, root), "utf8");
const body = async (path: string) => JSON.parse(await fixture(path)) as unknown;
const bytes = (value: string) => new TextEncoder().encode(value);

test("five evidence fixtures have pinned canonical wire bytes and digests", async () => {
  const golden = JSON.parse(await fixture("evidence/digests.json")) as Record<string, { bytes: number; sha256: string }>;
  for (const [name, expected] of Object.entries(golden)) {
    const encoded = encodeWire(await body(`evidence/${name}`) as never);
    assert.equal(encoded.byteLength, expected.bytes, name);
    assert.equal(digestBytes(encoded), expected.sha256, name);
    assert.equal(text.decode(encoded), text.decode(encodeWire(decodeWire(encoded))), name);
  }
});

test("D25 fixtures use the normative schema and mandated state digest", async () => {
  const valid = ["request.json", "active.json", "renewal.json", "denied.json"];
  const invalid = ["invalid-extra-field.json", "invalid-lease.json", "invalid-denial.json", "invalid-capability.json"];
  for (const name of valid) validateWire(await body(`space-state/${name}`));
  for (const name of invalid) {
    const value = await body(`space-state/${name}`);
    assert.throws(() => validateWire(value), name);
  }
  const active = await body("space-state/active.json");
  const renewal = await body("space-state/renewal.json");
  const denied = await body("space-state/denied.json");
  assert.equal(projectionDigest(active as never), (active as { projectionDigest: string }).projectionDigest);
  assert.equal(projectionDigest(active as never), projectionDigest(renewal as never));
  assert.equal(projectionDigest(denied as never), (denied as { projectionDigest: string }).projectionDigest);
  const digestGolden = JSON.parse(await fixture("space-state/digests.json")) as Record<string, { wireBodySha256: string }>;
  for (const [name, expected] of Object.entries(digestGolden)) {
    const value = await body(`space-state/${name}`);
    assert.equal(digestBytes(bytes(JSON.stringify(value))), expected.wireBodySha256, name);
  }
});

test("rejects unknown properties, duplicate references, invalid offsets, and oversized evidence", async () => {
  const approved = await body("evidence/approved-response.json") as Record<string, unknown>;
  assert.throws(() => validateWire({ ...approved, extra: true }));
  const passage = (approved.passages as unknown[])[0];
  assert.throws(() => validateWire({ ...approved, passages: [passage, passage] }));
  assert.throws(() => validateWire({ ...approved, passages: [{ ...(passage as Record<string, unknown>), ref: { ...((passage as { ref: object }).ref), startByte: 2, endByte: 2 } }] }));
  assert.throws(() => validateWire({ ...approved, passages: [{ ...(passage as Record<string, unknown>), ref: { ...((passage as { ref: object }).ref), endByte: 20 } }] }));
  const request = await body("evidence/search-request.json") as Record<string, unknown>;
  assert.throws(() => validateWire({ ...request, query: "" }));
  assert.throws(() => validateWire({ ...request, query: "a".repeat(2_049) }));
});

test("strict JSON rejects malformed UTF-8, duplicate escaped names, lone surrogates, and excessive depth", () => {
  assert.throws(() => decodeWire(new Uint8Array(32_769)));
  assert.throws(() => decodeWire(Uint8Array.of(0xc3, 0x28)));
  assert.throws(() => decodeWire(bytes('{"type":"CLOSED","\\u0074ype":"CLOSED","v":1,"requestId":"11111111111111111111111111111111","spaceAlias":"22222222222222222222222222222222"}')));
  assert.throws(() => decodeWire(bytes('{"v":1,"type":"CLOSED","requestId":"11111111111111111111111111111111","spaceAlias":"22222222222222222222222222222222","\\u005f\\u005fproto__":true}')));
  assert.throws(() => decodeJson(bytes('"\\ud800"')));
  assert.throws(() => decodeJson(bytes("\u00a0null")));
  assert.deepEqual(decodeJson(bytes('"😀"')), "😀");
  assert.deepEqual(decodeJson(bytes('"\\ud83d\\ude00"')), "😀");
  assert.throws(() => decodeJson(bytes("x1")));
  assert.throws(() => decodeJson(bytes(`${"[".repeat(33)}0${"]".repeat(33)}`)));
});

test("general canonical digests sort properties recursively", () => {
  assert.equal(canonicalDigest({ z: [{ b: 2, a: 1 }], a: true }), canonicalDigest({ a: true, z: [{ a: 1, b: 2 }] }));
  assert.throws(() => canonicalDigest("\uD800"));
  assert.throws(() => canonicalDigest(JSON.parse(`${"[".repeat(33)}0${"]".repeat(33)}`)));
});
