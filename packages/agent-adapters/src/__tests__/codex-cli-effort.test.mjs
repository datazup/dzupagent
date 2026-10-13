// Narrow provider-free qualification of the actual owned adapter source.
// Does not substitute for the package Vitest suite or qualify a live CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import test from 'node:test';

const root = await fs.mkdtemp('/data/storage/datazup-runtime/ninel/evidence/codex-effort-test-');
const adapterSource = fileURLToPath(new URL('../codex/codex-cli-adapter.ts', import.meta.url));
const result = await build({ entryPoints: [adapterSource], bundle: true, write: false, platform: 'node', format: 'esm',
  banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(import.meta.url)});` },
  plugins: [{ name: 'installed-package-ports', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) => ({
      path: args.path.startsWith('node:') ? args.path : fileURLToPath(import.meta.resolve(args.path)), external: true,
    }));
  } }],
});
const bundle = path.join(root, 'adapter.mjs');
await fs.writeFile(bundle, result.outputFiles[0].contents, { mode: 0o600 });
const { CodexCliAdapter } = await import(pathToFileURL(bundle));
test.after(() => fs.rm(root, { recursive: true, force: true }));

const snapshot = { model: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  evidenceRef: 'evidence:fixture-native-observation', expiresAt: '2099-01-01T00:00:00Z' };
for (const reasoning of ['low', 'medium', 'high', 'xhigh', 'max']) {
  test(`actual adapter emits qualified ${reasoning} exactly`, () => {
    const adapter = new CodexCliAdapter({ model: snapshot.model, nativeReasoning: snapshot });
    const args = adapter.buildArgs({ prompt: 'bounded', options: { reasoning } });
    assert.equal(args[args.indexOf('--model') + 1], snapshot.model);
    assert.equal(args[args.indexOf('--config') + 1], `model_reasoning_effort="${reasoning}"`);
  });
}
test('legacy efforts and omitted effort preserve compatibility', () => {
  const adapter = new CodexCliAdapter();
  for (const reasoning of ['low', 'medium', 'high'])
    assert.ok(adapter.buildArgs({ prompt: 'bounded', options: { reasoning } }).includes(`model_reasoning_effort="${reasoning}"`));
  assert.ok(!adapter.buildArgs({ prompt: 'bounded' }).includes('--config'));
});
for (const reasoning of ['max', 'ultra', '', false, 2, null]) {
  test(`invalid/unqualified ${reasoning} refuses before any provider effect`, async () => {
    let effects = 0;
    const adapter = new CodexCliAdapter({ runtimeDependencies: { spawn() { effects++; throw new Error('provider effect'); } } });
    const generator = adapter.executeWithRaw({ prompt: 'bounded', options: { reasoning } });
    await assert.rejects(generator.next(), /reasoning effort/);
    assert.equal(effects, 0);
  });
}
test('expired evidence and a changed model refuse rather than fall back', () => {
  for (const nativeReasoning of [{ ...snapshot, expiresAt: '2000-01-01T00:00:00Z' }, { ...snapshot, model: 'other' }]) {
    const adapter = new CodexCliAdapter({ model: snapshot.model, nativeReasoning });
    assert.throws(() => adapter.buildArgs({ prompt: 'bounded', options: { reasoning: 'max' } }), /reasoning effort/);
  }
  const adapter = new CodexCliAdapter({ model: snapshot.model, nativeReasoning: snapshot });
  assert.throws(() => adapter.buildArgs({ prompt: 'bounded', options: { model: 'other', reasoning: 'max' } }), /reasoning effort/);
});
