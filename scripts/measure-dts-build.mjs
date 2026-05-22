import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PACKAGES = [
  'create-dzupagent',
  '@dzupagent/adapter-rules',
  '@dzupagent/adapter-types',
  '@dzupagent/agent',
  '@dzupagent/agent-adapters',
  '@dzupagent/agent-types',
  '@dzupagent/app-tools',
  '@dzupagent/cache',
  '@dzupagent/code-edit-kit',
  '@dzupagent/codegen',
  '@dzupagent/connectors',
  '@dzupagent/connectors-browser',
  '@dzupagent/connectors-documents',
  '@dzupagent/context',
  '@dzupagent/core',
  '@dzupagent/eval-contracts',
  '@dzupagent/evals',
  '@dzupagent/express',
  '@dzupagent/flow-ast',
  '@dzupagent/flow-compiler',
  '@dzupagent/flow-dsl',
  '@dzupagent/hitl-kit',
  '@dzupagent/memory',
  '@dzupagent/memory-ipc',
  '@dzupagent/otel',
  '@dzupagent/rag',
  '@dzupagent/runtime-contracts',
  '@dzupagent/scraper',
  '@dzupagent/security',
  '@dzupagent/server',
  '@dzupagent/testing',
  '@dzupagent/test-utils',
];

const DEFAULT_BUDGET_FILE = 'scripts/dts-budgets.json';
const DECLARATION_DIAGNOSTICS_TIMEOUT_MS = 120_000;
const MEASUREMENT_STATES = new Set([
  'artifact-scan',
  'current-workspace',
  'fresh-forced-build',
  'partial-workspace',
  'post-workspace-build',
  'warm-emit',
]);
const MEASUREMENT_STATE_ALIASES = new Map([
  ['cold', 'fresh-forced-build'],
  ['partial', 'partial-workspace'],
  ['warm', 'warm-emit'],
]);

function parseArgs(argv) {
  const options = {
    build: false,
    check: false,
    declarationDiagnostics: false,
    declarationEmit: false,
    diagnosticsJsonSummary: false,
    json: false,
    budgetFile: DEFAULT_BUDGET_FILE,
    measurementLabel: undefined,
    measurementState: undefined,
    packages: [],
    runs: 1,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--build') {
      options.build = true;
      continue;
    }
    if (arg === '--declaration-emit') {
      options.declarationEmit = true;
      continue;
    }
    if (arg === '--declaration-diagnostics') {
      options.declarationDiagnostics = true;
      continue;
    }
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--diagnostics-json-summary') {
      options.diagnosticsJsonSummary = true;
      options.json = true;
      continue;
    }
    if (arg === '--measurement-label') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      options.measurementLabel = value;
      index += 1;
      continue;
    }
    if (arg === '--measurement-state') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      options.measurementState = normalizeMeasurementState(value);
      index += 1;
      continue;
    }
    if (arg === '--runs') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--runs requires a positive integer');
      }
      options.runs = value;
      index += 1;
      continue;
    }
    if (arg === '--budget-file') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      options.budgetFile = value;
      index += 1;
      continue;
    }
    if (arg === '--package' || arg === '--packages') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      options.packages.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    options.packages.push(arg);
  }

  if (options.packages.length === 0) {
    options.packages = [...DEFAULT_PACKAGES];
  }
  if (options.declarationDiagnostics) {
    options.declarationEmit = true;
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/measure-dts-build.mjs [options] [package...]

Measures declaration-output size and, with --build, package build duration.

Options:
  --package <name[,name]>  Package name or packages/<dir> path to measure
  --build                 Run yarn workspace <pkg> build before measuring
  --declaration-emit      Run package declaration-only tsc emit before measuring
  --declaration-diagnostics
                          Capture tsc diagnostics for declaration emit
  --diagnostics-json-summary
                          Print compact JSON with diagnostics summaries and stats
  --measurement-state <state>
                          Label the run state: fresh-forced-build, warm-emit, partial-workspace
                          Aliases: cold, warm, partial
  --measurement-label <label>
                          Free-form label included in JSON/text output
  --check                 Fail when measured output exceeds DTS budgets
  --budget-file <path>    Budget file for --check (default: ${DEFAULT_BUDGET_FILE})
  --runs <count>          Repeat timed build/declaration steps for profiling (default: 1)
  --json                  Print machine-readable JSON
  -h, --help              Show this help

Default packages: ${DEFAULT_PACKAGES.join(', ')}`);
}

function normalizeMeasurementState(value) {
  const normalized = String(value).trim().toLowerCase();
  const canonical = MEASUREMENT_STATE_ALIASES.get(normalized) ?? normalized;
  if (!MEASUREMENT_STATES.has(canonical)) {
    throw new Error(
      `--measurement-state must be one of ${[...MEASUREMENT_STATES].join(', ')} `
      + `(aliases: ${[...MEASUREMENT_STATE_ALIASES.keys()].join(', ')})`,
    );
  }
  return canonical;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readBudgetFile(root, budgetFile) {
  const budgetPath = path.resolve(root, budgetFile);
  return readJson(budgetPath);
}

async function listWorkspacePackages(root) {
  const packagesRoot = path.join(root, 'packages');
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join('packages', entry.name);
    const packageJsonPath = path.join(root, packageDir, 'package.json');
    if (!existsSync(packageJsonPath)) continue;

    const packageJson = await readJson(packageJsonPath);
    packages.push({
      dir: packageDir,
      name: packageJson.name ?? packageDir,
      packageJson,
    });
  }

  return packages;
}

function packageMatches(pkg, specifier) {
  return pkg.name === specifier
    || pkg.dir === specifier
    || pkg.dir === specifier.replace(/^\.\//, '')
    || path.basename(pkg.dir) === specifier;
}

function getExportSubpathCount(packageJson) {
  const exportsValue = packageJson.exports;
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) {
    return 0;
  }
  return Object.keys(exportsValue).length;
}

function parseTsupEntries(tsupConfigText) {
  const entryMatch = tsupConfigText.match(/\bentry\s*:\s*(\[[\s\S]*?\]|\{[\s\S]*?\})\s*,/);
  if (!entryMatch) return { count: 0, entries: [] };

  const entryBlock = entryMatch[1];
  const entries = [];
  for (const match of entryBlock.matchAll(/['"]([^'"]+\.ts)['"]/g)) {
    entries.push(match[1]);
  }
  return { count: entries.length, entries };
}

function summarizeRootBarrel(rootIndexText) {
  const sources = new Set();
  let explicitExports = 0;
  let starExports = 0;

  const exportBlockRe = /export(?:\s+type)?\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
  const exportStarRe = /export(?:\s+type)?\s+\*\s+from\s*['"]([^'"]+)['"]/g;

  for (const match of rootIndexText.matchAll(exportBlockRe)) {
    sources.add(match[2]);
    explicitExports += match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .length;
  }

  for (const match of rootIndexText.matchAll(exportStarRe)) {
    sources.add(match[1]);
    starExports += 1;
  }

  return {
    sourceCount: sources.size,
    explicitExportCount: explicitExports,
    starExportCount: starExports,
  };
}

async function walkFiles(dir) {
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const childPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(childPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(childPath);
    }
  }

  return files;
}

async function summarizeDeclarations({ root, packageDir }) {
  const distDir = path.join(root, packageDir, 'dist');
  const files = await walkFiles(distDir);
  const declarationFiles = files.filter((file) => file.endsWith('.d.ts'));
  const declarationMapFiles = files.filter((file) => file.endsWith('.d.ts.map'));
  let declarationBytes = 0;
  let declarationMapBytes = 0;
  const byTopDirectory = new Map();

  for (const file of declarationFiles) {
    const stats = await stat(file);
    declarationBytes += stats.size;
    const relative = path.relative(distDir, file);
    const top = relative.includes(path.sep) ? relative.split(path.sep)[0] : '<root>';
    byTopDirectory.set(top, (byTopDirectory.get(top) ?? 0) + 1);
  }

  for (const file of declarationMapFiles) {
    const stats = await stat(file);
    declarationMapBytes += stats.size;
  }

  return {
    declarationFileCount: declarationFiles.length,
    declarationMapFileCount: declarationMapFiles.length,
    declarationBytes,
    declarationMapBytes,
    topDeclarationDirs: [...byTopDirectory.entries()]
      .map(([dir, count]) => ({ dir, count }))
      .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
      .slice(0, 12),
  };
}

async function runBuild(packageName) {
  const startedAt = process.hrtime.bigint();

  await new Promise((resolve, reject) => {
    const child = spawn('yarn', ['workspace', packageName, 'build'], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`yarn workspace ${packageName} build failed with ${signal ?? code}`));
    });
  });

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  return Math.round(durationMs);
}

function getDeclarationEmitCommand(root, packageDir, options = {}) {
  const tsconfigBuildPath = path.join(root, packageDir, 'tsconfig.build.json');
  const tscPath = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const args = [tscPath];
  if (existsSync(tsconfigBuildPath)) {
    args.push('-p', 'tsconfig.build.json');
  }
  args.push('--emitDeclarationOnly', '--declarationMap', 'false');
  if (options.extendedDiagnostics) {
    args.push('--diagnostics', '--pretty', 'false');
  }
  return { command: process.execPath, args };
}

async function runDeclarationEmit({ root, packageDir, packageName, collectDiagnostics = false }) {
  const startedAt = process.hrtime.bigint();
  let output = '';
  const { command, args } = getDeclarationEmitCommand(root, packageDir, {
    extendedDiagnostics: collectDiagnostics,
  });

  if (collectDiagnostics) {
    try {
      const tscCommand = [command, ...args].map(shellQuote).join(' ');
      // TypeScript diagnostics can be suppressed when captured from a non-TTY parent on this machine.
      // `script` gives tsc a pseudo-terminal while still returning parseable text to this process.
      output = execSync(`script -q -e -c ${shellQuote(tscCommand)} /dev/null`, {
        cwd: path.join(root, packageDir),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DECLARATION_DIAGNOSTICS_TIMEOUT_MS,
      });
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error
        ? error.status
        : 'unknown';
      const reason = error && typeof error === 'object' && error.signal === 'SIGTERM'
        ? `timed out after ${DECLARATION_DIAGNOSTICS_TIMEOUT_MS / 1000}s`
        : `failed with ${status}`;
      throw new Error(`${packageName} declaration emit ${reason}`);
    }
  } else {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: path.join(root, packageDir),
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`${packageName} declaration emit failed with ${signal ?? code}`));
      });
    });
  }

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  return {
    durationMs: Math.round(durationMs),
    diagnostics: collectDiagnostics ? parseTscExtendedDiagnostics(output) : undefined,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function toCamelCase(label) {
  const words = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return undefined;
  return words
    .map((word, index) => (index === 0 ? word : `${word[0].toUpperCase()}${word.slice(1)}`))
    .join('');
}

export function parseTscExtendedDiagnostics(output) {
  const metrics = {};
  const timeMs = {};
  let memoryUsedKb;

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+):\s+([0-9]+(?:\.[0-9]+)?)([a-zA-Z]+)?\s*$/);
    if (!match) continue;

    const [, label, rawValue, rawUnit = 'count'] = match;
    const key = toCamelCase(label);
    if (!key) continue;

    const value = Number(rawValue);
    const unit = rawUnit === 'K' ? 'KiB' : rawUnit;
    metrics[key] = {
      label: label.trim(),
      value,
      unit,
    };

    if (unit === 's') {
      timeMs[key] = Math.round(value * 1000);
    } else if (unit === 'ms') {
      timeMs[key] = Math.round(value);
    }

    if (key === 'memoryUsed' && unit === 'KiB') {
      memoryUsedKb = value;
    }
  }

  return {
    metrics,
    timeMs,
    memoryUsedKb,
    metricCount: Object.keys(metrics).length,
    rawLength: output.length,
  };
}

function summarizeDurationSamples(samples) {
  if (samples.length === 0) return undefined;

  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
  const totalMs = samples.reduce((sum, value) => sum + value, 0);

  return {
    count: samples.length,
    minMs: sorted[0],
    medianMs,
    meanMs: Math.round(totalMs / samples.length),
    maxMs: sorted[sorted.length - 1],
    lastMs: samples[samples.length - 1],
    samplesMs: samples,
  };
}

function summarizeNumericSamples(samples) {
  if (samples.length === 0) return undefined;

  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
  const total = samples.reduce((sum, value) => sum + value, 0);

  return {
    count: samples.length,
    min: sorted[0],
    median,
    mean: Math.round(total / samples.length),
    max: sorted[sorted.length - 1],
    last: samples[samples.length - 1],
    samples,
  };
}

function inferBuildSampleState(options) {
  if (options.measurementState) return options.measurementState;
  return 'post-workspace-build';
}

function inferDeclarationSampleState(options, runIndex) {
  if (options.measurementState) return options.measurementState;
  if (options.build) return 'post-workspace-build';
  if (runIndex > 0) return 'warm-emit';
  return 'current-workspace';
}

function createMeasurementSample({ options, runIndex, durationMs, state }) {
  return {
    run: runIndex + 1,
    durationMs,
    measurementState: state,
    measurementLabel: options.measurementLabel,
  };
}

function createMeasurementContext(options) {
  let state = 'artifact-scan';
  if (options.measurementState) {
    state = options.measurementState;
  } else if (options.build) {
    state = 'post-workspace-build';
  } else if (options.declarationEmit) {
    state = options.runs > 1 ? 'warm-emit' : 'current-workspace';
  }

  return {
    state,
    label: options.measurementLabel,
    runs: options.runs,
  };
}

export function summarizeTscExtendedDiagnostics(diagnostics) {
  if (!diagnostics) return undefined;
  const metricValue = (...keys) => {
    for (const key of keys) {
      const value = diagnostics.metrics[key]?.value;
      if (value !== undefined) return value;
    }
    return undefined;
  };

  return {
    metricCount: diagnostics.metricCount,
    rawLength: diagnostics.rawLength,
    files: metricValue('files'),
    linesOfLibrary: metricValue('linesOfLibrary'),
    linesOfDefinitions: metricValue('linesOfDefinitions'),
    linesOfTypeScript: metricValue('linesOfTypeScript', 'linesOfTypescript'),
    identifiers: metricValue('identifiers'),
    symbols: metricValue('symbols'),
    types: metricValue('types'),
    instantiations: metricValue('instantiations'),
    memoryUsedKb: diagnostics.memoryUsedKb,
    timeMs: Object.fromEntries(
      Object.entries(diagnostics.timeMs).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function summarizeTscDiagnosticSamples(samples) {
  const summaries = samples
    .map((sample) => sample.diagnosticsSummary)
    .filter(Boolean);
  if (summaries.length === 0) return undefined;

  const timeKeys = new Set();
  for (const summary of summaries) {
    for (const key of Object.keys(summary.timeMs)) {
      timeKeys.add(key);
    }
  }

  const timeMs = {};
  for (const key of [...timeKeys].sort()) {
    const values = summaries
      .map((summary) => summary.timeMs[key])
      .filter((value) => value !== undefined);
    const stats = summarizeDurationSamples(values);
    if (stats) {
      timeMs[key] = stats;
    }
  }

  const memoryValues = summaries
    .map((summary) => summary.memoryUsedKb)
    .filter((value) => value !== undefined);

  return {
    count: summaries.length,
    timeMs,
    memoryUsedKb: summarizeNumericSamples(memoryValues),
  };
}

function pickFirstDefined(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function printText(results) {
  for (const result of results) {
    console.log(`\n${result.name} (${result.dir})`);
    if (result.measurement?.state || result.measurement?.label) {
      const parts = [];
      if (result.measurement.state) parts.push(result.measurement.state);
      if (result.measurement.label) parts.push(result.measurement.label);
      console.log(`  measurement: ${parts.join(', ')}`);
    }
    if (result.buildDurationMs !== undefined) {
      console.log(`  build: ${(result.buildDurationMs / 1000).toFixed(2)}s`);
      if (result.buildDurationStats?.count > 1) {
        console.log(
          `  build samples: ${result.buildDurationStats.samplesMs.map((duration) => (duration / 1000).toFixed(2)).join('s, ')}s `
          + `(min ${(result.buildDurationStats.minMs / 1000).toFixed(2)}s, `
          + `median ${(result.buildDurationStats.medianMs / 1000).toFixed(2)}s, `
          + `max ${(result.buildDurationStats.maxMs / 1000).toFixed(2)}s)`,
        );
      }
    }
    if (result.declarationEmitDurationMs !== undefined) {
      console.log(`  declaration emit: ${(result.declarationEmitDurationMs / 1000).toFixed(2)}s`);
      if (result.declarationEmitDurationStats?.count > 1) {
        console.log(
          `  declaration emit samples: ${result.declarationEmitDurationStats.samplesMs.map((duration) => (duration / 1000).toFixed(2)).join('s, ')}s `
          + `(min ${(result.declarationEmitDurationStats.minMs / 1000).toFixed(2)}s, `
          + `median ${(result.declarationEmitDurationStats.medianMs / 1000).toFixed(2)}s, `
          + `max ${(result.declarationEmitDurationStats.maxMs / 1000).toFixed(2)}s)`,
        );
      }
    }
    if (result.declarationDiagnostics) {
      const { timeMs, memoryUsedKb } = summarizeTscExtendedDiagnostics(result.declarationDiagnostics);
      const diagnosticParts = [
        ['parse', timeMs.parseTime],
        ['I/O read', pickFirstDefined(timeMs, ['iORead', 'iOReadTime'])],
        ['bind', timeMs.bindTime],
        ['check', timeMs.checkTime],
        ['emit', timeMs.emitTime],
        ['total', timeMs.totalTime],
      ]
        .filter(([, value]) => value !== undefined)
        .map(([label, value]) => `${label} ${(value / 1000).toFixed(2)}s`);
      if (memoryUsedKb !== undefined) {
        diagnosticParts.push(`memory ${formatBytes(memoryUsedKb * 1024)}`);
      }
      if (diagnosticParts.length > 0) {
        console.log(`  declaration diagnostics: ${diagnosticParts.join(', ')}`);
      }
    }
    if (result.declarationDiagnosticsStats?.count > 1) {
      const diagnosticStats = result.declarationDiagnosticsStats.timeMs;
      const statsParts = [
        ['parse', diagnosticStats.parseTime],
        ['I/O read', pickFirstDefined(diagnosticStats, ['iORead', 'iOReadTime'])],
        ['check', diagnosticStats.checkTime],
        ['emit', diagnosticStats.emitTime],
        ['total', diagnosticStats.totalTime],
      ]
        .filter(([, stats]) => stats)
        .map(([label, stats]) => `${label} median ${(stats.medianMs / 1000).toFixed(2)}s max ${(stats.maxMs / 1000).toFixed(2)}s`);
      if (statsParts.length > 0) {
        console.log(`  declaration diagnostics stats: ${statsParts.join(', ')}`);
      }
    }
    console.log(`  exports: ${result.exportSubpathCount} package subpaths`);
    console.log(`  tsup entries: ${result.tsupEntryCount}`);
    console.log(
      `  root barrel: ${result.rootBarrel.sourceCount} sources, `
      + `${result.rootBarrel.explicitExportCount} explicit exports, `
      + `${result.rootBarrel.starExportCount} star exports`,
    );
    console.log(
      `  declarations: ${result.declarations.declarationFileCount} files, `
      + `${formatBytes(result.declarations.declarationBytes)}`,
    );
    console.log(
      `  declaration maps: ${result.declarations.declarationMapFileCount} files, `
      + `${formatBytes(result.declarations.declarationMapBytes)}`,
    );
    if (result.declarations.topDeclarationDirs.length > 0) {
      const topDirs = result.declarations.topDeclarationDirs
        .map(({ dir, count }) => `${dir}:${count}`)
        .join(', ');
      console.log(`  top declaration dirs: ${topDirs}`);
    }
  }
}

export function createDiagnosticsJsonSummary({ generatedAt, results, budgetResult }) {
  return {
    generatedAt,
    results: results.map((result) => ({
      name: result.name,
      dir: result.dir,
      measurement: result.measurement,
      buildDurationMs: result.buildDurationMs,
      buildDurationStats: result.buildDurationStats,
      buildSamples: result.buildSamples,
      declarationEmitDurationMs: result.declarationEmitDurationMs,
      declarationEmitDurationStats: result.declarationEmitDurationStats,
      declarationEmitSamples: result.declarationEmitSamples,
      declarationDiagnostics: result.declarationDiagnosticsSummary,
      declarationDiagnosticsStats: result.declarationDiagnosticsStats,
      exportSubpathCount: result.exportSubpathCount,
      tsupEntryCount: result.tsupEntryCount,
      rootBarrel: result.rootBarrel,
      declarations: result.declarations,
    })),
    budgetResult,
  };
}

function formatBudgetValue(metric, value) {
  if (metric.toLowerCase().endsWith('bytes')) {
    return formatBytes(value);
  }
  if (metric.toLowerCase().endsWith('ms')) {
    return `${(value / 1000).toFixed(2)}s`;
  }
  return String(value);
}

function isMinimumMetric(metric) {
  return metric.startsWith('min');
}

function getMeasuredMetric(result, metric) {
  switch (metric) {
    case 'maxBuildDurationMs':
      return result.buildDurationStats?.maxMs ?? result.buildDurationMs;
    case 'maxDeclarationEmitDurationMs':
      return result.declarationEmitDurationStats?.maxMs ?? result.declarationEmitDurationMs;
    case 'minDeclarationFiles':
    case 'maxDeclarationFiles':
      return result.declarations.declarationFileCount;
    case 'minDeclarationBytes':
    case 'maxDeclarationBytes':
      return result.declarations.declarationBytes;
    case 'maxDeclarationMapFiles':
      return result.declarations.declarationMapFileCount;
    case 'maxDeclarationMapBytes':
      return result.declarations.declarationMapBytes;
    default:
      return undefined;
  }
}

export function evaluateBudgets(results, budgetConfig) {
  const packageBudgets = budgetConfig?.packages;
  if (!packageBudgets || typeof packageBudgets !== 'object' || Array.isArray(packageBudgets)) {
    throw new Error('DTS budget file must contain a "packages" object');
  }

  const messages = [];
  const supportedMetrics = [
    'minDeclarationFiles',
    'minDeclarationBytes',
    'maxBuildDurationMs',
    'maxDeclarationEmitDurationMs',
    'maxDeclarationFiles',
    'maxDeclarationBytes',
    'maxDeclarationMapFiles',
    'maxDeclarationMapBytes',
  ];

  for (const result of results) {
    const budget = packageBudgets[result.name];
    if (!budget) {
      messages.push(`${result.name}: no DTS budget configured`);
      continue;
    }

    for (const metric of supportedMetrics) {
      const limit = budget[metric];
      if (limit === undefined) continue;
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
        throw new Error(`${result.name} ${metric} budget must be a non-negative number`);
      }

      const measured = getMeasuredMetric(result, metric);
      if (measured === undefined) {
        continue;
      }
      if (isMinimumMetric(metric) ? measured < limit : measured > limit) {
        const relation = isMinimumMetric(metric) ? 'below minimum' : 'exceeded';
        messages.push(
          `${result.name}: ${metric} ${relation} `
          + `(measured ${formatBudgetValue(metric, measured)}, budget ${formatBudgetValue(metric, limit)})`,
        );
      }
    }
  }

  return {
    ok: messages.length === 0,
    messages,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const root = process.cwd();
  const packages = await listWorkspacePackages(root);
  const results = [];

  for (const specifier of options.packages) {
    const pkg = packages.find((candidate) => packageMatches(candidate, specifier));
    if (!pkg) {
      throw new Error(`Unknown workspace package: ${specifier}`);
    }

    const buildSamples = [];
    const declarationEmitSamples = [];
    let declarationDiagnostics;
    for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
      if (options.build) {
        const durationMs = await runBuild(pkg.name);
        buildSamples.push(createMeasurementSample({
          options,
          runIndex,
          durationMs,
          state: inferBuildSampleState(options),
        }));
      }
      if (options.declarationEmit) {
        const emitResult = await runDeclarationEmit({
          root,
          packageDir: pkg.dir,
          packageName: pkg.name,
          collectDiagnostics: options.declarationDiagnostics,
        });
        const diagnosticsSummary = summarizeTscExtendedDiagnostics(emitResult.diagnostics);
        declarationEmitSamples.push({
          ...createMeasurementSample({
            options,
            runIndex,
            durationMs: emitResult.durationMs,
            state: inferDeclarationSampleState(options, runIndex),
          }),
          diagnosticsSummary,
        });
        if (emitResult.diagnostics) {
          declarationDiagnostics = emitResult.diagnostics;
        }
      }
    }
    const buildDurationStats = summarizeDurationSamples(buildSamples.map((sample) => sample.durationMs));
    const declarationEmitDurationStats = summarizeDurationSamples(declarationEmitSamples.map((sample) => sample.durationMs));
    const buildDurationMs = buildDurationStats?.lastMs;
    const declarationEmitDurationMs = declarationEmitDurationStats?.lastMs;
    const tsupConfigPath = path.join(root, pkg.dir, 'tsup.config.ts');
    const tsupConfigText = existsSync(tsupConfigPath)
      ? await readFile(tsupConfigPath, 'utf8')
      : '';
    const tsupEntries = parseTsupEntries(tsupConfigText);
    const rootIndexPath = path.join(root, pkg.dir, 'src', 'index.ts');
    const rootIndexText = existsSync(rootIndexPath)
      ? await readFile(rootIndexPath, 'utf8')
      : '';

    results.push({
      name: pkg.name,
      dir: pkg.dir,
      measurement: createMeasurementContext(options),
      buildDurationMs,
      buildDurationStats,
      buildSamples,
      declarationEmitDurationMs,
      declarationEmitDurationStats,
      declarationEmitSamples,
      declarationDiagnostics,
      declarationDiagnosticsSummary: summarizeTscExtendedDiagnostics(declarationDiagnostics),
      declarationDiagnosticsStats: summarizeTscDiagnosticSamples(declarationEmitSamples),
      exportSubpathCount: getExportSubpathCount(pkg.packageJson),
      tsupEntryCount: tsupEntries.count,
      tsupEntries: tsupEntries.entries,
      rootBarrel: summarizeRootBarrel(rootIndexText),
      declarations: await summarizeDeclarations({ root, packageDir: pkg.dir }),
    });
  }

  if (options.json) {
    const budgetResult = options.check
      ? evaluateBudgets(results, await readBudgetFile(root, options.budgetFile))
      : undefined;
    const generatedAt = new Date().toISOString();
    const payload = options.diagnosticsJsonSummary
      ? createDiagnosticsJsonSummary({ generatedAt, results, budgetResult })
      : { generatedAt, results, budgetResult };
    console.log(JSON.stringify(payload, null, 2));
    if (budgetResult && !budgetResult.ok) {
      process.exitCode = 1;
    }
    return;
  }

  printText(results);
  if (options.check) {
    const budgetResult = evaluateBudgets(results, await readBudgetFile(root, options.budgetFile));
    if (budgetResult.ok) {
      console.log('\nDTS budgets: ok');
      return;
    }

    console.error('\nDTS budgets failed:');
    for (const message of budgetResult.messages) {
      console.error(`  - ${message}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
