import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDiagnosticsJsonSummary,
  evaluateBudgets,
  parseTscExtendedDiagnostics,
  summarizeTscExtendedDiagnostics,
} from '../measure-dts-build.mjs';

function makeResult(name, overrides = {}) {
  return {
    name,
    buildDurationMs: overrides.buildDurationMs,
    buildDurationStats: overrides.buildDurationStats,
    declarationEmitDurationMs: overrides.declarationEmitDurationMs,
    declarationEmitDurationStats: overrides.declarationEmitDurationStats,
    declarations: {
      declarationFileCount: overrides.declarationFileCount ?? 1,
      declarationBytes: overrides.declarationBytes ?? 100,
      declarationMapFileCount: overrides.declarationMapFileCount ?? 0,
      declarationMapBytes: overrides.declarationMapBytes ?? 0,
    },
  };
}

test('passes when measured declaration output stays within budget', () => {
  const result = evaluateBudgets(
    [makeResult('@dzupagent/codegen', { declarationFileCount: 10, declarationBytes: 2000 })],
    {
      packages: {
        '@dzupagent/codegen': {
          minDeclarationFiles: 1,
          minDeclarationBytes: 100,
          maxDeclarationFiles: 10,
          maxDeclarationBytes: 2000,
          maxDeclarationMapFiles: 0,
          maxDeclarationMapBytes: 0,
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.messages, []);
});

test('uses the slowest declaration emit sample for duration budgets', () => {
  const result = evaluateBudgets(
    [
      makeResult('@dzupagent/core', {
        declarationEmitDurationMs: 8_000,
        declarationEmitDurationStats: {
          count: 3,
          minMs: 8_000,
          medianMs: 9_000,
          meanMs: 10_667,
          maxMs: 15_000,
          lastMs: 8_000,
          samplesMs: [9_000, 15_000, 8_000],
        },
      }),
    ],
    {
      packages: {
        '@dzupagent/core': {
          maxDeclarationEmitDurationMs: 10_000,
        },
      },
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.messages.join('\n'), /@dzupagent\/core: maxDeclarationEmitDurationMs exceeded/);
  assert.match(result.messages.join('\n'), /measured 15\.00s, budget 10\.00s/);
});

test('parses tsc extended diagnostics into stable numeric fields', () => {
  const diagnostics = parseTscExtendedDiagnostics(`
Files:                         382
Lines of Library:            40124
Memory used:               219580K
I/O Read time:                0.02s
Parse time:                  1.21s
Bind time:                   0.41s
Check time:                 18.54s
Emit time:                   2.07s
Total time:                 22.62s
`);

  assert.equal(diagnostics.metrics.files.value, 382);
  assert.equal(diagnostics.metricCount, 9);
  assert.ok(diagnostics.rawLength > 0);
  assert.equal(diagnostics.metrics.memoryUsed.unit, 'KiB');
  assert.equal(diagnostics.memoryUsedKb, 219580);
  assert.equal(diagnostics.timeMs.iOReadTime, 20);
  assert.equal(diagnostics.timeMs.parseTime, 1210);
  assert.equal(diagnostics.timeMs.bindTime, 410);
  assert.equal(diagnostics.timeMs.checkTime, 18540);
  assert.equal(diagnostics.timeMs.emitTime, 2070);
  assert.equal(diagnostics.timeMs.totalTime, 22620);
});

test('summarizes tsc diagnostics into compact comparison fields', () => {
  const diagnostics = parseTscExtendedDiagnostics(`
Files:                         382
Lines of Library:            40124
Lines of TypeScript:          2011
Identifiers:                 55000
Symbols:                     41000
Types:                       12000
Instantiations:              26000
Memory used:               219580K
I/O Read time:                0.02s
Parse time:                  1.21s
Check time:                 18.54s
Emit time:                   2.07s
Total time:                 22.62s
`);

  const summary = summarizeTscExtendedDiagnostics(diagnostics);

  assert.equal(summary.files, 382);
  assert.equal(summary.linesOfLibrary, 40124);
  assert.equal(summary.linesOfTypeScript, 2011);
  assert.equal(summary.identifiers, 55000);
  assert.equal(summary.symbols, 41000);
  assert.equal(summary.types, 12000);
  assert.equal(summary.instantiations, 26000);
  assert.equal(summary.memoryUsedKb, 219580);
  assert.equal(summary.timeMs.iOReadTime, 20);
  assert.equal(summary.timeMs.checkTime, 18540);
  assert.equal(summary.metrics, undefined);
});

test('creates compact diagnostics JSON without full metric maps', () => {
  const diagnostics = parseTscExtendedDiagnostics(`
Files:                         10
Memory used:                 2048K
Parse time:                  0.10s
Check time:                  0.30s
Emit time:                   0.05s
Total time:                  0.50s
`);
  const diagnosticsSummary = summarizeTscExtendedDiagnostics(diagnostics);
  const payload = createDiagnosticsJsonSummary({
    generatedAt: '2026-05-22T00:00:00.000Z',
    results: [
      {
        name: '@dzupagent/core',
        dir: 'packages/core',
        measurement: { state: 'warm-emit', label: 'local-runs', runs: 2 },
        declarationEmitDurationMs: 500,
        declarationEmitDurationStats: {
          count: 2,
          minMs: 500,
          medianMs: 550,
          meanMs: 550,
          maxMs: 600,
          lastMs: 500,
          samplesMs: [600, 500],
        },
        declarationEmitSamples: [
          {
            run: 1,
            durationMs: 600,
            measurementState: 'current-workspace',
            measurementLabel: 'local-runs',
            diagnosticsSummary,
          },
        ],
        declarationDiagnosticsSummary: diagnosticsSummary,
        declarationDiagnosticsStats: {
          count: 1,
          timeMs: {
            checkTime: {
              count: 1,
              minMs: 300,
              medianMs: 300,
              meanMs: 300,
              maxMs: 300,
              lastMs: 300,
              samplesMs: [300],
            },
          },
        },
        declarations: {
          declarationFileCount: 1,
          declarationBytes: 100,
          declarationMapFileCount: 0,
          declarationMapBytes: 0,
          topDeclarationDirs: [],
        },
        exportSubpathCount: 1,
        rootBarrel: {
          sourceCount: 1,
          explicitExportCount: 1,
          starExportCount: 0,
        },
        tsupEntryCount: 1,
      },
    ],
    budgetResult: undefined,
  });

  assert.equal(payload.results[0].measurement.state, 'warm-emit');
  assert.equal(payload.results[0].declarationDiagnostics.checkTime, undefined);
  assert.equal(payload.results[0].declarationDiagnostics.timeMs.checkTime, 300);
  assert.equal(payload.results[0].declarationDiagnostics.metrics, undefined);
});

test('fails when declaration maps return for a budgeted package', () => {
  const result = evaluateBudgets(
    [
      makeResult('@dzupagent/server', {
        declarationMapFileCount: 1,
        declarationMapBytes: 512,
      }),
    ],
    {
      packages: {
        '@dzupagent/server': {
          maxDeclarationMapFiles: 0,
          maxDeclarationMapBytes: 0,
        },
      },
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.messages.join('\n'), /@dzupagent\/server: maxDeclarationMapFiles exceeded/);
  assert.match(result.messages.join('\n'), /@dzupagent\/server: maxDeclarationMapBytes exceeded/);
});

test('fails when declaration artifacts disappear for a budgeted package', () => {
  const result = evaluateBudgets(
    [
      makeResult('@dzupagent/codegen', {
        declarationFileCount: 0,
        declarationBytes: 0,
      }),
    ],
    {
      packages: {
        '@dzupagent/codegen': {
          minDeclarationFiles: 1,
          minDeclarationBytes: 1,
        },
      },
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.messages.join('\n'), /@dzupagent\/codegen: minDeclarationFiles below minimum/);
  assert.match(result.messages.join('\n'), /@dzupagent\/codegen: minDeclarationBytes below minimum/);
});

test('fails when a measured package has no configured budget', () => {
  const result = evaluateBudgets([makeResult('@dzupagent/agent')], { packages: {} });

  assert.equal(result.ok, false);
  assert.deepEqual(result.messages, ['@dzupagent/agent: no DTS budget configured']);
});

test('fails when declaration emit duration exceeds budget', () => {
  const result = evaluateBudgets(
    [makeResult('@dzupagent/core', { declarationEmitDurationMs: 12_000 })],
    {
      packages: {
        '@dzupagent/core': {
          maxDeclarationEmitDurationMs: 10_000,
        },
      },
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.messages.join('\n'), /@dzupagent\/core: maxDeclarationEmitDurationMs exceeded/);
  assert.match(result.messages.join('\n'), /measured 12\.00s, budget 10\.00s/);
});
