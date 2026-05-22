import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createMatrixCommands,
  parseMatrixArgs,
} from '../run-dts-benchmark-matrix.mjs';

test('plans default controlled DTS benchmark matrix commands', () => {
  const options = parseMatrixArgs([]);
  const commands = createMatrixCommands(options, { nodePath: 'node' });

  assert.equal(options.output, '/tmp/dzupagent-dts-benchmark.jsonl');
  assert.deepEqual(options.packages, ['@dzupagent/core', '@dzupagent/test-utils']);
  assert.equal(options.runs, 3);
  assert.equal(options.state, 'warm-emit');
  assert.equal(options.diagnosticsSampleMode, 'last');
  assert.equal(commands.length, 3);

  const [core, testUtils, summary] = commands;
  assert.equal(core.command, 'node');
  assert.equal(core.packageName, '@dzupagent/core');
  assert.equal(core.label, 'warm-matrix-dzupagent-core-runs-3');
  assert.deepEqual(core.args, [
    'scripts/measure-dts-build.mjs',
    '--declaration-emit',
    '--declaration-diagnostics',
    '--diagnostics-json-summary',
    '--measurement-state',
    'warm-emit',
    '--measurement-label',
    'warm-matrix-dzupagent-core-runs-3',
    '--runs',
    '3',
    '--diagnostics-sample-mode',
    'last',
    '--package',
    '@dzupagent/core',
    '--benchmark-output',
    '/tmp/dzupagent-dts-benchmark.jsonl',
  ]);
  assert.equal(testUtils.packageName, '@dzupagent/test-utils');
  assert.equal(summary.label, 'summary');
  assert.match(summary.args.join(' '), /--benchmark-summary-runs 3/);
  assert.match(summary.args.join(' '), /--benchmark-summary-diagnostics-sample-mode last/);
});

test('plans custom matrix lane and disables summary', () => {
  const options = parseMatrixArgs([
    '--package',
    '@dzupagent/core,packages/test-utils',
    '--output',
    '/tmp/custom.jsonl',
    '--runs',
    '5',
    '--measurement-state',
    'warm',
    '--diagnostics-sample-mode',
    'all',
    '--label-prefix',
    'controlled',
    '--no-summary',
  ]);
  const commands = createMatrixCommands(options, { nodePath: 'node' });

  assert.equal(commands.length, 2);
  assert.equal(commands[0].label, 'controlled-dzupagent-core-runs-5');
  assert.equal(commands[1].label, 'controlled-packages-test-utils-runs-5');
  assert.deepEqual(commands[0].args.slice(-2), ['--benchmark-output', '/tmp/custom.jsonl']);
  assert.match(commands[0].args.join(' '), /--runs 5/);
  assert.match(commands[0].args.join(' '), /--diagnostics-sample-mode all/);
});

test('rejects invalid matrix run count and diagnostics mode', () => {
  assert.throws(() => parseMatrixArgs(['--runs', '0']), /--runs requires a positive integer/);
  assert.throws(
    () => parseMatrixArgs(['--diagnostics-sample-mode', 'middle']),
    /--diagnostics-sample-mode must be one of/,
  );
});
