import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PACKAGES = ['@dzupagent/core', '@dzupagent/test-utils'];
const DEFAULT_OUTPUT = '/tmp/dzupagent-dts-benchmark.jsonl';
const DIAGNOSTICS_SAMPLE_MODES = new Set(['last', 'all']);
const MEASUREMENT_STATE_ALIASES = new Map([
  ['cold', 'fresh-forced-build'],
  ['partial', 'partial-workspace'],
  ['warm', 'warm-emit'],
]);
const MEASUREMENT_STATES = new Set([
  'artifact-scan',
  'current-workspace',
  'fresh-forced-build',
  'partial-workspace',
  'post-workspace-build',
  'warm-emit',
]);

function normalizeDiagnosticsSampleMode(value) {
  const normalized = String(value).trim().toLowerCase();
  if (!DIAGNOSTICS_SAMPLE_MODES.has(normalized)) {
    throw new Error(`--diagnostics-sample-mode must be one of ${[...DIAGNOSTICS_SAMPLE_MODES].join(', ')}`);
  }
  return normalized;
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

function slugifyPackageName(packageName) {
  return String(packageName)
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function parseMatrixArgs(argv) {
  const options = {
    diagnosticsSampleMode: 'last',
    dryRun: false,
    json: true,
    labelPrefix: 'warm-matrix',
    output: DEFAULT_OUTPUT,
    packages: [],
    runs: 3,
    state: 'warm-emit',
    summary: true,
    summaryTargetMaxEmitMs: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--package' || arg === '--packages') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options.packages.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }
    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options.output = value;
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
    if (arg === '--measurement-state') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options.state = normalizeMeasurementState(value);
      index += 1;
      continue;
    }
    if (arg === '--diagnostics-sample-mode') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options.diagnosticsSampleMode = normalizeDiagnosticsSampleMode(value);
      index += 1;
      continue;
    }
    if (arg === '--label-prefix') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options.labelPrefix = value;
      index += 1;
      continue;
    }
    if (arg === '--summary-target-max-emit-ms') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--summary-target-max-emit-ms requires a positive integer');
      }
      options.summaryTargetMaxEmitMs = value;
      index += 1;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--no-json') {
      options.json = false;
      continue;
    }
    if (arg === '--no-summary') {
      options.summary = false;
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

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/run-dts-benchmark-matrix.mjs [options] [package...]

Runs a controlled DTS declaration-emit benchmark matrix and appends rows to JSONL.

Options:
  --package <name[,name]>       Package name or packages/<dir> path to benchmark
  --output <path>               Benchmark JSONL output (default: ${DEFAULT_OUTPUT})
  --runs <count>                Repeat declaration emit per package (default: 3)
  --measurement-state <state>   Lane state label (default: warm-emit; aliases: warm, cold, partial)
  --diagnostics-sample-mode <last|all>
                                Diagnostics sampling mode (default: last)
  --label-prefix <label>        Prefix for package labels (default: warm-matrix)
  --summary-target-max-emit-ms <ms>
                                Report whether summary lanes stay under this max emit target
  --dry-run                     Print commands without running them
  --no-json                     Do not print per-package JSON payloads
  --no-summary                  Skip summary after collection
  -h, --help                    Show this help

Default packages: ${DEFAULT_PACKAGES.join(', ')}`);
}

export function createMatrixCommands(options, { nodePath = process.execPath } = {}) {
  const scriptPath = path.join('scripts', 'measure-dts-build.mjs');
  const commands = options.packages.map((packageName) => {
    const label = `${options.labelPrefix}-${slugifyPackageName(packageName)}-runs-${options.runs}`;
    const args = [
      scriptPath,
      '--declaration-emit',
      '--declaration-diagnostics',
      '--diagnostics-json-summary',
      '--measurement-state',
      options.state,
      '--measurement-label',
      label,
      '--runs',
      String(options.runs),
      '--diagnostics-sample-mode',
      options.diagnosticsSampleMode,
      '--package',
      packageName,
      '--benchmark-output',
      options.output,
    ];
    if (!options.json) {
      const jsonIndex = args.indexOf('--diagnostics-json-summary');
      args.splice(jsonIndex, 1);
    }
    return {
      command: nodePath,
      args,
      label,
      packageName,
    };
  });

  if (options.summary) {
    const args = [
      scriptPath,
      '--benchmark-summary',
      options.output,
      '--benchmark-summary-state',
      options.state,
      '--benchmark-summary-runs',
      String(options.runs),
      '--benchmark-summary-diagnostics-sample-mode',
      options.diagnosticsSampleMode,
      '--benchmark-summary-limit',
      '5',
    ];
    if (options.summaryTargetMaxEmitMs !== undefined) {
      args.push('--benchmark-summary-target-max-emit-ms', String(options.summaryTargetMaxEmitMs));
    }
    commands.push({
      command: nodePath,
      args,
      label: 'summary',
      packageName: undefined,
    });
  }

  return commands;
}

function quoteCommand(command) {
  return [command.command, ...command.args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

async function runCommand(command) {
  await new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command.label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

async function main() {
  const options = parseMatrixArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const commands = createMatrixCommands(options);
  if (options.dryRun) {
    for (const command of commands) {
      console.log(quoteCommand(command));
    }
    return;
  }

  for (const command of commands) {
    console.log(`\n[dts-benchmark] ${command.label}`);
    await runCommand(command);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
