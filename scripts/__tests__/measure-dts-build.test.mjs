import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createBenchmarkRecord,
  createDiagnosticsJsonSummary,
  evaluateBudgets,
  parseTscExtendedDiagnostics,
  printBenchmarkSummary,
  shouldCollectDiagnostics,
  summarizeBenchmarkRecords,
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
I/O Read:                    0.02s
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
  assert.equal(diagnostics.timeMs.iORead, 20);
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
I/O Read:                    0.02s
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
  assert.equal(summary.timeMs.iORead, 20);
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

test('collects diagnostics on the last run by default', () => {
  const options = {
    declarationDiagnostics: true,
    diagnosticsSampleMode: 'last',
    runs: 3,
  };

  assert.equal(shouldCollectDiagnostics(options, 0), false);
  assert.equal(shouldCollectDiagnostics(options, 1), false);
  assert.equal(shouldCollectDiagnostics(options, 2), true);
});

test('collects diagnostics on every run when requested', () => {
  const options = {
    declarationDiagnostics: true,
    diagnosticsSampleMode: 'all',
    runs: 3,
  };

  assert.equal(shouldCollectDiagnostics(options, 0), true);
  assert.equal(shouldCollectDiagnostics(options, 1), true);
  assert.equal(shouldCollectDiagnostics(options, 2), true);
});

test('creates compact benchmark records for persisted comparisons', () => {
  const record = createBenchmarkRecord({
    generatedAt: '2026-05-22T00:00:00.000Z',
    results: [
      {
        name: '@dzupagent/core',
        dir: 'packages/core',
        measurement: {
          state: 'warm-emit',
          label: 'warm-repeat',
          runs: 3,
          diagnosticsSampleMode: 'last',
        },
        buildSamples: [],
        declarationEmitDurationMs: 500,
        declarationEmitDurationStats: {
          count: 3,
          minMs: 500,
          medianMs: 550,
          meanMs: 600,
          maxMs: 750,
          lastMs: 500,
          samplesMs: [750, 550, 500],
        },
        declarationEmitSamples: [
          {
            run: 3,
            durationMs: 500,
            measurementState: 'warm-emit',
            measurementLabel: 'warm-repeat',
            diagnosticsSummary: {
              metricCount: 1,
              rawLength: 20,
              files: 10,
              memoryUsedKb: 2048,
              timeMs: { totalTime: 500 },
            },
          },
        ],
        declarationDiagnosticsSummary: {
          metricCount: 1,
          rawLength: 20,
          files: 10,
          memoryUsedKb: 2048,
          timeMs: { totalTime: 500 },
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

  assert.equal(record.schemaVersion, 1);
  assert.equal(record.kind, 'dts-benchmark');
  assert.equal(record.results[0].measurement.diagnosticsSampleMode, 'last');
  assert.equal(record.results[0].declarationDiagnostics.metrics, undefined);
});

test('summarizes benchmark records with latest rows and deltas', () => {
  const records = [
    createBenchmarkRecord({
      generatedAt: '2026-05-22T00:00:00.000Z',
      results: [
        {
          name: '@dzupagent/core',
          dir: 'packages/core',
          measurement: { state: 'warm-emit', label: 'before', runs: 3 },
          declarationEmitDurationStats: {
            count: 3,
            minMs: 900,
            medianMs: 1000,
            meanMs: 1100,
            maxMs: 1400,
            lastMs: 900,
            samplesMs: [1400, 1000, 900],
          },
          declarationDiagnosticsSummary: {
            timeMs: {
              totalTime: 1200,
              parseTime: 800,
              iORead: 100,
              checkTime: 200,
              emitTime: 100,
            },
          },
          declarations: {
            declarationFileCount: 1,
            declarationBytes: 100,
            declarationMapFileCount: 2,
            declarationMapBytes: 50,
          },
        },
      ],
      budgetResult: undefined,
    }),
    createBenchmarkRecord({
      generatedAt: '2026-05-22T00:01:00.000Z',
      results: [
        {
          name: '@dzupagent/core',
          dir: 'packages/core',
          measurement: { state: 'warm-emit', label: 'after', runs: 3 },
          declarationEmitDurationStats: {
            count: 3,
            minMs: 700,
            medianMs: 800,
            meanMs: 850,
            maxMs: 1000,
            lastMs: 700,
            samplesMs: [1000, 800, 700],
          },
          declarationDiagnosticsSummary: {
            timeMs: {
              totalTime: 900,
              parseTime: 600,
              iORead: 80,
              checkTime: 150,
              emitTime: 70,
            },
          },
          declarations: {
            declarationFileCount: 2,
            declarationBytes: 90,
            declarationMapFileCount: 0,
            declarationMapBytes: 0,
          },
        },
      ],
      budgetResult: undefined,
    }),
  ];

  const summary = summarizeBenchmarkRecords(records);
  const core = summary.packages[0];

  assert.equal(summary.recordCount, 2);
  assert.equal(summary.rowCount, 2);
  assert.equal(core.packageName, '@dzupagent/core');
  assert.equal(core.latest.label, 'after');
  assert.equal(core.deltaFromPrevious.declarationEmitMedianMs.delta, -200);
  assert.equal(core.deltaFromPrevious.declarationEmitMedianMs.percent, -20);
  assert.equal(core.deltaFromPrevious.diagnosticsTotalMs.delta, -300);
  assert.equal(core.deltaFromPrevious.declarationFileCount.delta, 1);
  assert.equal(core.deltaFromPrevious.declarationBytes.delta, -10);
  assert.equal(core.deltaFromPrevious.declarationMapFileCount.delta, -2);
  assert.equal(core.deltaFromPrevious.declarationMapBytes.delta, -50);
});

test('compares benchmark deltas only against compatible package lanes', () => {
  const records = [
    createBenchmarkRecord({
      generatedAt: '2026-05-22T00:00:00.000Z',
      results: [
        {
          name: '@dzupagent/core',
          dir: 'packages/core',
          measurement: { state: 'warm-emit', label: 'compatible-before', runs: 1 },
          declarationEmitDurationStats: {
            count: 1,
            minMs: 1000,
            medianMs: 1000,
            meanMs: 1000,
            maxMs: 1000,
            lastMs: 1000,
            samplesMs: [1000],
          },
          declarations: {
            declarationFileCount: 1,
            declarationBytes: 100,
            declarationMapFileCount: 1,
            declarationMapBytes: 10,
          },
        },
      ],
      budgetResult: undefined,
    }),
    createBenchmarkRecord({
      generatedAt: '2026-05-22T00:01:00.000Z',
      results: [
        {
          name: '@dzupagent/core',
          dir: 'packages/core',
          measurement: { state: 'warm-emit', label: 'different-run-count', runs: 3 },
          declarationEmitDurationStats: {
            count: 3,
            minMs: 2000,
            medianMs: 2500,
            meanMs: 2600,
            maxMs: 3000,
            lastMs: 3000,
            samplesMs: [2000, 2500, 3000],
          },
          declarations: {
            declarationFileCount: 2,
            declarationBytes: 200,
            declarationMapFileCount: 2,
            declarationMapBytes: 20,
          },
        },
      ],
      budgetResult: undefined,
    }),
    createBenchmarkRecord({
      generatedAt: '2026-05-22T00:02:00.000Z',
      results: [
        {
          name: '@dzupagent/core',
          dir: 'packages/core',
          measurement: { state: 'warm-emit', label: 'compatible-after', runs: 1 },
          declarationEmitDurationStats: {
            count: 1,
            minMs: 700,
            medianMs: 700,
            meanMs: 700,
            maxMs: 700,
            lastMs: 700,
            samplesMs: [700],
          },
          declarations: {
            declarationFileCount: 1,
            declarationBytes: 100,
            declarationMapFileCount: 0,
            declarationMapBytes: 0,
          },
        },
      ],
      budgetResult: undefined,
    }),
  ];

  const summary = summarizeBenchmarkRecords(records);
  const core = summary.packages[0];

  assert.equal(core.previous.label, 'different-run-count');
  assert.equal(core.incompatiblePrevious.label, 'different-run-count');
  assert.equal(core.latestCompatiblePrevious.label, 'compatible-before');
  assert.equal(core.deltaFromCompatiblePrevious.declarationEmitMedianMs.delta, -300);
  assert.equal(core.deltaFromPrevious.declarationEmitMedianMs.delta, -300);
  assert.equal(core.deltaFromPrevious.declarationMapFileCount.delta, -1);
  assert.equal(core.artifactDeltaFromPrevious.declarationMapFileCount.delta, -2);
});

test('omits benchmark deltas when no compatible previous lane exists', () => {
  const records = [
    createBenchmarkRecord({
      generatedAt: '2026-05-22T00:00:00.000Z',
      results: [
        {
          name: '@dzupagent/core',
          dir: 'packages/core',
          measurement: { state: 'warm-emit', label: 'before', runs: 3 },
          declarationEmitDurationStats: {
            count: 3,
            minMs: 1000,
            medianMs: 1200,
            meanMs: 1200,
            maxMs: 1400,
            lastMs: 1400,
            samplesMs: [1000, 1200, 1400],
          },
          declarations: {
            declarationFileCount: 1,
            declarationBytes: 100,
            declarationMapFileCount: 1,
            declarationMapBytes: 10,
          },
        },
      ],
      budgetResult: undefined,
    }),
    createBenchmarkRecord({
      generatedAt: '2026-05-22T00:01:00.000Z',
      results: [
        {
          name: '@dzupagent/core',
          dir: 'packages/core',
          measurement: { state: 'warm-emit', label: 'after', runs: 1 },
          declarationEmitDurationStats: {
            count: 1,
            minMs: 700,
            medianMs: 700,
            meanMs: 700,
            maxMs: 700,
            lastMs: 700,
            samplesMs: [700],
          },
          declarations: {
            declarationFileCount: 1,
            declarationBytes: 100,
            declarationMapFileCount: 0,
            declarationMapBytes: 0,
          },
        },
      ],
      budgetResult: undefined,
    }),
  ];

  const summary = summarizeBenchmarkRecords(records);
  const core = summary.packages[0];

  assert.equal(core.previous.label, 'before');
  assert.equal(core.latestCompatiblePrevious, undefined);
  assert.equal(core.deltaFromPrevious, undefined);
  assert.equal(core.incompatiblePrevious.label, 'before');
  assert.equal(core.artifactDeltaFromPrevious.declarationMapFileCount.delta, -1);
});

test('filters benchmark summary rows by package and compatible lane fields', () => {
  const records = [
    createBenchmarkRecord({
      generatedAt: '2026-05-22T00:00:00.000Z',
      results: [
        {
          name: '@dzupagent/core',
          dir: 'packages/core',
          measurement: {
            state: 'warm-emit',
            label: 'core-warm',
            runs: 3,
            diagnosticsSampleMode: 'last',
          },
          declarationEmitDurationStats: {
            count: 3,
            minMs: 1000,
            medianMs: 1200,
            meanMs: 1200,
            maxMs: 1400,
            lastMs: 1400,
            samplesMs: [1000, 1200, 1400],
          },
          declarations: {
            declarationFileCount: 1,
            declarationBytes: 100,
            declarationMapFileCount: 0,
            declarationMapBytes: 0,
          },
        },
        {
          name: '@dzupagent/test-utils',
          dir: 'packages/test-utils',
          measurement: {
            state: 'warm-emit',
            label: 'test-utils-warm',
            runs: 3,
            diagnosticsSampleMode: 'last',
          },
          declarationEmitDurationStats: {
            count: 3,
            minMs: 500,
            medianMs: 600,
            meanMs: 600,
            maxMs: 700,
            lastMs: 700,
            samplesMs: [500, 600, 700],
          },
          declarations: {
            declarationFileCount: 1,
            declarationBytes: 50,
            declarationMapFileCount: 0,
            declarationMapBytes: 0,
          },
        },
      ],
      budgetResult: undefined,
    }),
    createBenchmarkRecord({
      generatedAt: '2026-05-22T00:01:00.000Z',
      results: [
        {
          name: '@dzupagent/core',
          dir: 'packages/core',
          measurement: {
            state: 'warm-emit',
            label: 'core-one-run',
            runs: 1,
            diagnosticsSampleMode: 'last',
          },
          declarationEmitDurationStats: {
            count: 1,
            minMs: 900,
            medianMs: 900,
            meanMs: 900,
            maxMs: 900,
            lastMs: 900,
            samplesMs: [900],
          },
          declarations: {
            declarationFileCount: 1,
            declarationBytes: 100,
            declarationMapFileCount: 0,
            declarationMapBytes: 0,
          },
        },
      ],
      budgetResult: undefined,
    }),
  ];

  const summary = summarizeBenchmarkRecords(records, {
    filters: {
      packages: ['core'],
      state: 'warm-emit',
      runs: 3,
      diagnosticsSampleMode: 'last',
    },
  });

  assert.deepEqual(summary.filters, {
    packages: ['core'],
    state: 'warm-emit',
    runs: 3,
    diagnosticsSampleMode: 'last',
  });
  assert.equal(summary.rowCount, 1);
  assert.equal(summary.packages.length, 1);
  assert.equal(summary.packages[0].packageName, '@dzupagent/core');
  assert.equal(summary.packages[0].latest.label, 'core-warm');
});

test('benchmark summary text distinguishes missing artifact bytes from zero bytes', () => {
  const messages = [];
  const originalLog = console.log;
  try {
    console.log = (message = '') => {
      messages.push(String(message));
    };
    printBenchmarkSummary(summarizeBenchmarkRecords([
      {
        schemaVersion: 1,
        kind: 'dts-benchmark',
        generatedAt: '2026-05-22T00:00:00.000Z',
        results: [
          {
            name: '@dzupagent/core',
            dir: 'packages/core',
            measurement: { state: 'warm-emit', label: 'legacy', runs: 1 },
            declarations: {
              declarationFileCount: 1,
              declarationMapFileCount: 0,
            },
          },
        ],
      },
    ]));

    assert.match(messages.join('\n'), /artifacts: 1 declarations, -, 0 maps, -/);
  } finally {
    console.log = originalLog;
  }
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
