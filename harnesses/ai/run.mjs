#!/usr/bin/env node
/**
 * Independent AI harness: embed passages, rank them against a question, then run
 * a grounded local summary through the same contracts the core uses.
 *
 *   node --import tsx run.mjs                          scripted backend, no model
 *   node --import tsx run.mjs --with-qvac              real QVAC models on this device
 *   node --import tsx run.mjs --with-qvac \
 *     --question "What blocks the release?" --source notes.txt
 *
 * The scripted backend answers from a fixed script and proves nothing about
 * inference. Only --with-qvac loads and executes the pinned QVAC models.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createAiAdapter, QvacClient, QVAC_EMBEDDING_PROFILE, QVAC_GENERATION_PROFILE } from '@kuro/ai';
import { FakeQvacRuntime } from '@kuro/ai/testing';
import { LIMITS, validatePreparation, validateVectors } from '@kuro/contracts';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = name => { const hit = argv.find(value => value.startsWith(`--${name}=`)); if (hit) return hit.slice(name.length + 3); const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const options = name => { const values = []; for (let i = 0; i < argv.length; i++) { if (argv[i] === `--${name}`) { if (argv[i + 1]) values.push(argv[++i]); } else if (argv[i].startsWith(`--${name}=`)) values.push(argv[i].slice(name.length + 3)); } return values; };

const real = flag('with-qvac');
const embeddingsOnly = flag('embeddings-only');
const json = flag('json');
const limit = Math.min(Number(option('limit') ?? 3) || 3, LIMITS.maxPassages);
const question = option('question') ?? 'What still has to happen before the pilot can be released?';

/** Synthetic corpus. Mixed relevance so ranking has to do real work. */
const SAMPLE_PASSAGES = [
  'The KURO pilot remains provisional. Release requires a signed human review; the September checkpoint alone does not authorize publication.',
  'Outstanding observations: the vendor payment has not been approved and is still waiting on the finance lead.',
  'The office move is scheduled for the second week of November. Desk assignments will be published beforehand.',
  'Release engineering confirmed the build is reproducible on all three supported platforms as of the last checkpoint.',
  'Catering for the all-hands has been booked. Dietary requirements were collected last Friday.',
];

/** The AI contract accepts at most four blocks per embedding call. */
const EMBED_BATCH = 4;
const bytes = text => Buffer.byteLength(text, 'utf8');
const hex = (value, length) => createHash('sha256').update(value).digest('hex').slice(0, length);
const jobId = () => randomBytes(16).toString('hex');

/** One passage per source file, or per built-in sample line. */
async function loadPassages() {
  const files = options('source');
  const inline = options('text');
  const texts = [];
  for (const path of files) {
    const text = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n').trim();
    if (!text) throw new Error(`${path} is empty`);
    if (bytes(text) > LIMITS.maxBodyBytes) throw new Error(`${path} exceeds the ${LIMITS.maxBodyBytes}-byte passage limit`);
    texts.push({ label: path, text });
  }
  for (const text of inline) texts.push({ label: 'inline', text: text.trim() });
  if (!texts.length) for (const text of SAMPLE_PASSAGES) texts.push({ label: 'sample', text });
  const originKey = hex('kuro-harness-origin', 64);
  return texts.map(({ label, text }, index) => ({
    label,
    ref: { originKey, documentId: hex(`document:${label}:${index}`, 32), versionId: hex(`version:${label}:${index}`, 32), spanId: hex(`span:${label}:${index}`, 32), startByte: 0, endByte: bytes(text) },
    text,
  }));
}

const passages = await loadPassages();
const runtime = real ? new QvacClient() : new FakeQvacRuntime({
  // Scripted stand-in for a model answer. It is fixed text, not inference.
  completionResponses: [JSON.stringify({ status: 'answer', claims: [{ text: 'Scripted backend: a signed human review is still required.', sourceAliases: ['P1'] }] })],
});
const adapter = createAiAdapter(runtime);
const out = record => { console.log(json ? JSON.stringify(record) : formatRecord(record)); };

function formatRecord(record) {
  if (record.event === 'start') return `KURO AI harness · ${record.mode}\n  node ${record.node} ${record.platform}/${record.arch} · ${record.passages} passages loaded\n  question: ${record.question}`;
  if (record.event === 'embedded') return `\nEmbedded ${record.vectors} passages with ${record.modelId} (${record.dimension}-d, ${record.normalization}).`;
  if (record.event === 'ranked') return ['\nRanked passages:', ...record.ranked.map((r, i) => `  ${i + 1}. score ${r.score.toFixed(4)}  ${r.preview}`)].join('\n');
  if (record.event === 'prepared') return `\nPrepared context for ${record.modelId}: ${record.sources} sources, ${record.contextTokens} of ${record.contextTokens + record.reservedOutputTokens} budgeted bytes (${record.tokenAccounting}).`;
  if (record.event === 'answer') {
    const lines = [`\nAnswer (${record.status}, ${record.completion}):`];
    if (!record.claims.length) lines.push('  The model reported the evidence does not answer the question.');
    for (const claim of record.claims) { lines.push(`  • ${claim.text}`); for (const alias of claim.sourceAliases) lines.push(`      ${alias}: "${record.sources[alias]}"`); }
    lines.push(`\n  Every claim above still requires semantic review against its quoted source.`);
    return lines.join('\n');
  }
  return JSON.stringify(record);
}

try {
  const capabilities = await adapter.port.getCapabilities();
  assert.equal(capabilities.provider, real ? 'qvac' : 'simulated');
  out({ event: 'start', mode: real ? 'real-qvac' : 'scripted-qvac-backend', node: process.version, platform: process.platform, arch: process.arch, passages: passages.length, question });

  // The contract caps one embedding call at four blocks, so batch like core does.
  const blocks = passages.map(passage => ({ id: passage.ref.spanId, text: passage.text, ref: passage.ref }));
  const vectors = [];
  for (let offset = 0; offset < blocks.length; offset += EMBED_BATCH) {
    const batch = blocks.slice(offset, offset + EMBED_BATCH);
    const embedJob = jobId();
    const embedded = validateVectors(
      await adapter.port.embedBlocks({ jobId: embedJob, profile: QVAC_EMBEDDING_PROFILE, blocks: batch }),
      embedJob, QVAC_EMBEDDING_PROFILE, batch.map(block => block.id),
    );
    vectors.push(...embedded.vectors);
  }
  out({ event: 'embedded', vectors: vectors.length, modelId: QVAC_EMBEDDING_PROFILE.modelId, dimension: QVAC_EMBEDDING_PROFILE.dimension, normalization: QVAC_EMBEDDING_PROFILE.normalization });

  // The question is embedded with the same profile, so ranking is a real
  // similarity search rather than a fixed ordering.
  const queryJob = jobId();
  const queryId = hex('query', 32);
  const query = validateVectors(
    await adapter.port.embedBlocks({ jobId: queryJob, profile: QVAC_EMBEDDING_PROFILE, blocks: [{ id: queryId, text: question, ref: { ...passages[0].ref, spanId: queryId, endByte: bytes(question) } }] }),
    queryJob, QVAC_EMBEDDING_PROFILE, [queryId],
  );
  const ranked = await adapter.port.rankAllowed({ jobId: jobId(), profile: QVAC_EMBEDDING_PROFILE, query: query.vectors[0], candidates: vectors, limit });
  const byId = new Map(passages.map(passage => [passage.ref.spanId, passage]));
  const selected = ranked.ranked.map(entry => byId.get(entry.id)).filter(Boolean);
  assert.ok(selected.length, 'ranking returned no known passage');
  out({ event: 'ranked', ranked: ranked.ranked.map(entry => ({ score: entry.score, preview: `${byId.get(entry.id).text.slice(0, 88)}${byId.get(entry.id).text.length > 88 ? '…' : ''}` })) });

  if (!embeddingsOnly) {
    const input = { jobId: jobId(), preparationId: jobId(), deliveryId: jobId(), profile: QVAC_GENERATION_PROFILE, question, passages: selected.map(({ ref, text }) => ({ ref, text })) };
    const preparation = validatePreparation(await adapter.port.prepareSummary(input), input);
    out({ event: 'prepared', modelId: preparation.profile.modelId, sources: preparation.sources.length, contextTokens: preparation.contextTokens, reservedOutputTokens: preparation.reservedOutputTokens, tokenAccounting: preparation.tokenAccounting });

    const result = await adapter.port.runPreparedSummary(preparation);
    assert.equal(result.preparationDigest, preparation.digest);
    const aliases = new Map(preparation.sources.map(source => [source.alias, source.passage.text]));
    assert.ok(result.claims.every(claim => claim.sourceAliases.every(alias => aliases.has(alias))), 'model cited an unknown source alias');
    out({ event: 'answer', status: result.status, completion: result.completion, claims: result.claims, sources: Object.fromEntries(aliases), requiresSemanticReview: true });
  }
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', code: error?.code ?? error?.name ?? 'UNKNOWN', message: error?.message ?? String(error) }));
  process.exitCode = 1;
} finally {
  await adapter.close();
  if (!json) console.log('\nAI runtime closed.');
}
