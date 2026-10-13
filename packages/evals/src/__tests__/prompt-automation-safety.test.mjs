// Provider-free checks against bundled owned source. No real model or host is invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import test from 'node:test';

const root = await fs.mkdtemp('/data/storage/datazup-runtime/ninel/evidence/prompt-safety-test-');
test.after(() => fs.rm(root, { recursive: true, force: true }));
async function sourceModule(relative, name) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))], bundle: true,
    write: false, platform: 'node', format: 'esm',
    banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(import.meta.url)});` },
    plugins: [{ name: 'installed-ports', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, args => ({
        path: args.path.startsWith('node:') ? args.path : fileURLToPath(import.meta.resolve(args.path)), external: true,
      }));
    } }],
  });
  const file = path.join(root, `${name}.mjs`); await fs.writeFile(file, result.outputFiles[0].contents, { mode: 0o600 });
  return import(pathToFileURL(file));
}
const [{ PromptOptimizer }, { PromptExperiment }, { EvalDataset }, { createCostScorer }] = await Promise.all([
  sourceModule('../prompt-optimizer/prompt-optimizer-persistence.ts', 'optimizer'),
  sourceModule('../prompt-experiment/prompt-experiment.ts', 'experiment'),
  sourceModule('../dataset/eval-dataset.ts', 'dataset'),
  sourceModule('../scorers/deterministic-enhanced.ts', 'scorers'),
]);

const dataset = (input = 'training question') => EvalDataset.from([{ id: input === 'training question' ? 'train' : 'held', input }]);
function fixture({ score, invoke, meta } = {}) {
  const versions = new Map([['base', { id: 'base', promptKey: 'system', content: 'original', active: true,
    version: 1, createdAt: '2026-10-13T00:00:00Z' }]]);
  const calls = { save: 0, activate: 0, invoke: 0, meta: 0 };
  const store = {
    getActive: async key => structuredClone([...versions.values()].find(v => v.promptKey === key && v.active) ?? null),
    getById: async id => structuredClone(versions.get(id) ?? null),
    save: async params => {
      calls.save++; const value = { ...params, id: `candidate-${calls.save}`, version: calls.save + 1,
        createdAt: '2026-10-13T00:00:00Z' };
      if (value.active) for (const v of versions.values()) v.active = false;
      versions.set(value.id, structuredClone(value)); return structuredClone(value);
    },
    activate: async () => { calls.activate++; throw new Error('Unexpected activation'); },
  };
  const scorer = { config: { id: 'quality', name: 'quality', type: 'deterministic' }, score: async input => {
    const value = score ? score(input) : input.output === 'better' ? 0.9 : 0.4;
    return { scorerId: 'quality', aggregateScore: value, passed: value > 0,
      measured: true, scores: [{ criterion: 'quality', score: value, reasoning: 'fixture' }], durationMs: 0 };
  } };
  const config = { versionStore: store, scorers: [scorer], maxRounds: 1, maxCandidates: 1,
    metaModel: { invoke: async () => { calls.meta++; return meta ? meta() : {
      content: '### Candidate 1\nBetter clarity.\n```prompt\nbetter\n```',
    }; } },
    evalModel: { invoke: async messages => { calls.invoke++; return invoke ? invoke(messages, versions) : { content: messages[0].content }; } },
  };
  return { versions, calls, store, config, optimizer: new PromptOptimizer(config) };
}

test('rewrites stay inactive; training scores and content changes do not activate anything', async () => {
  const f = fixture(); const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() });
  assert.equal(result.improved, true); assert.equal(result.bestVersion.active, false);
  assert.equal(result.bestVersion.metadata.sourceVersionId, 'base');
  assert.equal(result.scoreImprovement, 0.5);
  assert.equal((await f.store.getActive('system')).id, 'base'); assert.equal(f.calls.activate, 0);
});

test('baseline rescoring without a rewrite does not save or report improvement', async () => {
  const f = fixture({ meta: () => ({ content: 'No candidates.' }) });
  const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() });
  assert.equal(result.improved, false); assert.equal(result.originalVersion.id, 'base');
  assert.equal(result.bestVersion.id, 'base'); assert.equal(f.calls.save, 0); assert.equal(f.calls.activate, 0);
});

test('a confirmation regression discards the apparent winner', async () => {
  let n = 0; const f = fixture({ score: () => [0.4, 0.9, 0.2][n++] });
  const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() });
  assert.equal(result.improved, false); assert.equal(f.calls.save, 0); assert.equal(f.calls.activate, 0);
});

test('empty data and unbounded configuration are refused before invoking a model', async () => {
  const f = fixture(); await assert.rejects(f.optimizer.optimize({ promptKey: 'system', dataset: EvalDataset.from([]) }), /nonempty dataset/);
  assert.equal(f.calls.invoke, 0); assert.equal(f.calls.meta, 0);
  assert.throws(() => new PromptOptimizer({ ...f.config, maxRounds: Infinity }), /Bounded/);
});

test('a model error preserves the real source version and leaves it active', async () => {
  const f = fixture({ meta: () => { throw new Error('fixture failure'); } });
  const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() });
  assert.equal(result.exitReason, 'error'); assert.equal(result.originalVersion.id, 'base');
  assert.equal((await f.store.getActive('system')).id, 'base'); assert.equal(f.calls.activate, 0);
});

test('disjoint held-out evaluation returns bound evidence without promoting', async () => {
  const f = fixture(); const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() });
  const evidence = await f.optimizer.validateCandidate({ promptKey: 'system', candidateVersionId: result.bestVersion.id,
    holdoutDataset: dataset('new held-out question') });
  assert.equal(evidence.passed, true); assert.equal(evidence.reason, 'passed');
  assert.equal(evidence.sourceVersionId, 'base'); assert.match(evidence.candidatePromptDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(evidence.trainingDatasetDigest, evidence.holdoutDatasetDigest);
  assert.equal((await f.store.getActive('system')).id, 'base'); assert.equal(f.calls.activate, 0);
});

test('changed case identities cannot disguise reused training inputs', async () => {
  const f = fixture(); const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() });
  const before = f.calls.invoke;
  await assert.rejects(f.optimizer.validateCandidate({ promptKey: 'system', candidateVersionId: result.bestVersion.id,
    holdoutDataset: EvalDataset.from([{ id: 'different-id', input: 'training question' }]) }), /overlap/);
  assert.equal(f.calls.invoke, before); assert.equal(f.calls.activate, 0);
});

test('a stale baseline is refused before held-out model calls', async () => {
  const f = fixture(); const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() });
  f.versions.get('base').content = 'changed baseline'; const before = f.calls.invoke;
  await assert.rejects(f.optimizer.validateCandidate({ promptKey: 'system', candidateVersionId: result.bestVersion.id,
    holdoutDataset: dataset('new held-out question') }), /source prompt changed/);
  assert.equal(f.calls.invoke, before); assert.equal(f.calls.activate, 0);
});

test('caller-supplied failure inputs cannot be reused as held-out inputs', async () => {
  const f = fixture(); let metaInput = '';
  f.config.metaModel.invoke = async messages => {
    f.calls.meta++; metaInput = messages[1].content;
    return { content: '### Candidate 1\nBetter clarity.\n```prompt\nbetter\n```' };
  };
  const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset(),
    failures: [{ input: 'external failure', output: 'wrong', feedback: 'fix this' }] });
  assert.ok(metaInput.includes('external failure'));
  const before = f.calls.invoke;
  await assert.rejects(f.optimizer.validateCandidate({ promptKey: 'system', candidateVersionId: result.bestVersion.id,
    holdoutDataset: EvalDataset.from([{ id: 'new-heldout-id', input: 'external failure' }]) }), /overlap/);
  assert.equal(f.calls.invoke, before); assert.equal(f.calls.activate, 0);
});

test('dataset evidence binds scorer tags and metadata with stable object-key ordering', async () => {
  const f = fixture(); const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() });
  const validate = (tags, metadata) => f.optimizer.validateCandidate({ promptKey: 'system',
    candidateVersionId: result.bestVersion.id,
    holdoutDataset: EvalDataset.from([{ id: 'held', input: 'new held-out question', tags, metadata }]) });
  const initial = await validate(['quality'], { score: 1, nested: { b: 2, a: 1 } });
  const reordered = await validate(['quality'], { nested: { a: 1, b: 2 }, score: 1 });
  const tagChanged = await validate(['other'], { score: 1, nested: { b: 2, a: 1 } });
  const metadataChanged = await validate(['quality'], { score: 0, nested: { b: 2, a: 1 } });
  assert.equal(initial.holdoutDatasetDigest, reordered.holdoutDatasetDigest);
  assert.notEqual(initial.holdoutDatasetDigest, tagChanged.holdoutDatasetDigest);
  assert.notEqual(initial.holdoutDatasetDigest, metadataChanged.holdoutDatasetDigest);
});

test('held-out evidence and scorer inputs use a snapshot taken before asynchronous lookup', async () => {
  const seen = []; const f = fixture({ invoke: messages => {
    seen.push(messages[1].content); return { content: messages[0].content };
  } });
  const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() });
  const entry = { id: 'held', input: 'new held-out question', tags: ['original'], metadata: { score: 1 } };
  const original = EvalDataset.from([structuredClone(entry)]);
  const external = EvalDataset.from([entry]); seen.length = 0;
  const pending = f.optimizer.validateCandidate({ promptKey: 'system', candidateVersionId: result.bestVersion.id,
    holdoutDataset: external });
  entry.input = 'training question'; entry.tags[0] = 'changed'; entry.metadata.score = 0;
  const actual = await pending;
  const expected = await f.optimizer.validateCandidate({ promptKey: 'system', candidateVersionId: result.bestVersion.id,
    holdoutDataset: original });
  assert.equal(actual.holdoutDatasetDigest, expected.holdoutDatasetDigest);
  assert.deepEqual(seen, Array(4).fill('new held-out question'));
});

for (const kind of ['nonfinite', 'function', 'cycle']) test('unsupported dataset evidence refuses before model calls: ' + kind, async () => {
  const metadata = kind === 'nonfinite' ? { score: NaN } : kind === 'function' ? { score() {} } : {};
  if (kind === 'cycle') metadata.self = metadata;
  const f = fixture();
  await assert.rejects(f.optimizer.optimize({ promptKey: 'system',
    dataset: EvalDataset.from([{ id: 'train', input: 'training question', metadata }]) }), /JSON values/);
  assert.equal(f.calls.invoke, 0); assert.equal(f.calls.meta, 0);
});

for (const kind of ['hidden-cycle', 'hidden-nonfinite', 'hidden-function', 'extra-array', 'hidden-array', 'sparse-array']) {
  test('unsupported property shapes refuse before model calls: ' + kind, async () => {
    const metadata = kind.endsWith('array') ? ['accepted'] : {};
    if (kind === 'hidden-cycle') Object.defineProperty(metadata, 'hidden', { value: metadata });
    if (kind === 'hidden-nonfinite') Object.defineProperty(metadata, 'hidden', { value: NaN });
    if (kind === 'hidden-function') Object.defineProperty(metadata, 'hidden', { value() {} });
    if (kind === 'extra-array') metadata.extra = () => {};
    if (kind === 'hidden-array') Object.defineProperty(metadata, 'hidden', { value: metadata });
    if (kind === 'sparse-array') metadata.length = 2;
    const f = fixture();
    await assert.rejects(f.optimizer.optimize({ promptKey: 'system',
      dataset: EvalDataset.from([{ id: 'train', input: 'training question', metadata }]) }), /JSON/);
    assert.equal(f.calls.invoke, 0); assert.equal(f.calls.meta, 0);
  });
}

test('baseline changes during held-out evaluation make the evidence stale', async () => {
  let validating = false;
  const f = fixture({ invoke: (messages, versions) => {
    if (validating) versions.get('base').content = 'changed while validating';
    return { content: messages[0].content };
  } });
  const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() }); validating = true;
  const evidence = await f.optimizer.validateCandidate({ promptKey: 'system', candidateVersionId: result.bestVersion.id,
    holdoutDataset: dataset('new held-out question') });
  assert.equal(evidence.passed, false); assert.equal(evidence.reason, 'source_changed'); assert.equal(f.calls.activate, 0);
});

test('held-out regressions fail even when training improved', async () => {
  const f = fixture({ score: input => input.input === 'training question' ? (input.output === 'better' ? 0.9 : 0.4)
    : (input.output === 'better' ? 0.2 : 0.8) });
  const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() });
  const evidence = await f.optimizer.validateCandidate({ promptKey: 'system', candidateVersionId: result.bestVersion.id,
    holdoutDataset: dataset('new held-out question') });
  assert.equal(evidence.reason, 'regression'); assert.equal(evidence.passed, false); assert.equal(f.calls.activate, 0);
});

test('an unmeasured mandatory check cannot disappear from held-out acceptance', async () => {
  const f = fixture(); f.config.scorers.push({ config: { id: 'unmeasured' }, score: async () => ({
    scorerId: 'unmeasured', aggregateScore: 1, passed: true, measured: false, scores: [], durationMs: 0,
  }) });
  const result = await f.optimizer.optimize({ promptKey: 'system', dataset: dataset() });
  const evidence = await f.optimizer.validateCandidate({ promptKey: 'system', candidateVersionId: result.bestVersion.id,
    holdoutDataset: dataset('new held-out question') });
  assert.equal(evidence.candidate.passRate, 0); assert.equal(evidence.passed, false); assert.equal(f.calls.activate, 0);
});

const variants = [{ id: 'one', name: 'one', systemPrompt: 'original' }, { id: 'two', name: 'two', systemPrompt: 'better' }];
async function experiment(costObservation, inputs = dataset(), withCostGate = false) {
  const f = fixture(); const config = { model: { invoke: async () => ({ content: 'better', usage_metadata: { total_tokens: 1000 } }) },
    scorers: withCostGate ? [...f.config.scorers, createCostScorer({ targetCents: 1, maxCents: 2 })] : f.config.scorers,
    ...(costObservation === undefined ? {} : { costObservation }) };
  return new PromptExperiment(config).run(variants, inputs);
}

test('token usage without cost evidence remains unknown and cannot pass a cost gate', async () => {
  const report = await experiment(undefined, dataset(), true);
  for (const v of report.variants) { assert.equal(v.avgCostCents, null); assert.equal(v.costState, 'unknown'); assert.equal(v.passRate, 0); }
  assert.ok(report.toMarkdown().includes('unknown'));
});

test('reported zero remains measured zero instead of becoming unknown', async () => {
  const report = await experiment(() => ({ costCents: 0, basis: 'reported', evidenceRef: 'usage:fixture' }), dataset(), true);
  for (const v of report.variants) { assert.equal(v.avgCostCents, 0); assert.equal(v.costState, 'reported'); assert.equal(v.passRate, 1); }
  assert.ok(report.toMarkdown().includes('0.000 | reported'));
});

test('estimates are labelled explicitly and incomplete coverage has no total average', async () => {
  const estimate = await experiment(() => ({ costCents: 0.5, basis: 'estimated', evidenceRef: 'tariff:fixture' }));
  assert.equal(estimate.variants[0].costState, 'estimated'); assert.equal(estimate.variants[0].avgCostCents, 0.5);
  const inputs = EvalDataset.from([{ id: 'a', input: 'first' }, { id: 'b', input: 'second' }]);
  const partial = await experiment((_response, entry) => entry.id === 'a'
    ? { costCents: 0.5, basis: 'reported', evidenceRef: 'usage:fixture' } : undefined, inputs);
  assert.equal(partial.variants[0].costState, 'partial'); assert.equal(partial.variants[0].avgCostCents, null);
  const mixed = await experiment((_response, entry) => ({ costCents: 0.5, basis: entry.id === 'a' ? 'reported' : 'estimated', evidenceRef: 'cost:fixture' }), inputs);
  assert.equal(mixed.variants[0].costState, 'mixed'); assert.equal(mixed.variants[0].avgCostCents, null);
});

for (const costCents of [NaN, Infinity, -1]) test(`invalid cost ${costCents} refuses evaluation evidence`, async () => {
  await assert.rejects(experiment(() => ({ costCents, basis: 'reported', evidenceRef: 'usage:fixture' })), /Invalid experiment cost/);
});

test('cost scorer distinguishes unknown/invalid input from zero', async () => {
  const scorer = createCostScorer({ targetCents: 1, maxCents: 2 });
  for (const costCents of [undefined, NaN, -1, Infinity]) {
    const result = await scorer.score({ input: 'q', output: 'a', costCents });
    assert.equal(result.passed, false); assert.equal(result.measured, false);
  }
  assert.equal((await scorer.score({ input: 'q', output: 'a', costCents: 0 })).passed, true);
});
