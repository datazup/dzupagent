/**
 * check-barrel-budgets.mjs
 *
 * Growth-halt gate for large public root barrels
 * (MC-7 / DZUPAGENT-CODE-L-05 + ARCH-LOW-01).
 *
 * Large root barrels (packages/core/src/index.ts ~1238 LOC / ~876 named
 * re-exports; packages/flow-ast/src/types.ts ~828 LOC) increase accidental
 * coupling. The intended end-state keeps the root barrel available for
 * back-compat but STOPS IT GROWING: new public API must land on a documented
 * subpath export (config/public-api-allowlists.json `subpaths`), not by
 * widening the root barrel.
 *
 * This gate reads each configured package's src/index.ts (and any configured
 * auxiliary source modules re-exported by the barrel), measures the same
 * root-barrel metrics that scripts/measure-dts-build.mjs already computes, and
 * FAILS when any metric exceeds its pinned baseline in
 * config/barrel-budgets.json. Budgets are pinned at the current measured count
 * so the gate is green today and red on any growth.
 *
 * Unlike `check:dts-budgets`, this gate is build-free: it inspects source only,
 * so it can run in any working tree without a dist/ build.
 *
 * Usage:
 *   node scripts/check-barrel-budgets.mjs           # enforce budgets (default)
 *   node scripts/check-barrel-budgets.mjs --report  # print measured metrics, never fails
 *   node scripts/check-barrel-budgets.mjs --json     # machine-readable output
 *   node scripts/check-barrel-budgets.mjs --budget-file <path>
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { summarizeRootBarrel } from './measure-dts-build.mjs';

const DEFAULT_BUDGET_FILE = 'config/barrel-budgets.json';

/**
 * Budget metrics that read directly from the root barrel summary.
 * All are MAX caps (growth-halt): measured must be <= budget.
 */
const ROOT_BARREL_METRICS = {
  maxRootBarrelExplicitExports: (summary) => summary.explicitExportCount,
  maxRootBarrelStarExports: (summary) => summary.starExportCount,
  maxRootBarrelSourceCount: (summary) => summary.sourceCount,
};

function parseArgs(argv) {
  const options = {
    report: false,
    json: false,
    budgetFile: DEFAULT_BUDGET_FILE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report') {
      options.report = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
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
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/check-barrel-budgets.mjs [options]

Growth-halt gate for large public root barrels. Reads source only (build-free).

Options:
  --report                Print measured metrics without failing
  --json                  Print machine-readable JSON
  --budget-file <path>    Budget file (default: ${DEFAULT_BUDGET_FILE})
  -h, --help              Show this help`);
}

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined;
}

function countLines(text) {
  if (text === undefined) return undefined;
  if (text === '') return 0;
  // Normalize trailing newline so a file ending in "\n" is not over-counted.
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return normalized.split('\n').length;
}

function sha256(text) {
  return text === undefined ? undefined : createHash('sha256').update(text).digest('hex');
}

function validateDebtPin({ debtPin, label, measured, metric, sourceSha256, now }) {
  if (!debtPin || typeof debtPin !== 'object' || Array.isArray(debtPin)) {
    return { ok: false, message: `${label}: ${metric} exceeds its target without a source-bound debt pin` };
  }
  const pinnedLimit = debtPin[metric];
  if (typeof pinnedLimit !== 'number' || !Number.isFinite(pinnedLimit) || pinnedLimit < 0) {
    return { ok: false, message: `${label}: debt pin ${metric} must be a non-negative number` };
  }
  if (measured > pinnedLimit) {
    return {
      ok: false,
      message: `${label}: ${metric} exceeded its source-bound debt pin `
        + `(measured ${measured}, pin ${pinnedLimit})`,
    };
  }
  if (typeof debtPin.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(debtPin.sourceSha256)) {
    return { ok: false, message: `${label}: debt pin sourceSha256 must be a lowercase SHA-256 digest` };
  }
  if (sourceSha256 !== debtPin.sourceSha256) {
    return {
      ok: false,
      message: `${label}: source-bound debt pin hash mismatch — the pinned bytes changed. `
        + `This is not a deadlock: re-pin in the SAME commit by setting sourceSha256 to ${sourceSha256}, `
        + `${metric} to the new measured value, sourceCommit to the commit you are basing on, `
        + `and a fresh reviewBy. Move the number toward the pin's shrinkTarget, never away from it`,
    };
  }
  // sourceCommit is provenance only and is deliberately NOT resolved against the
  // object database: requiring a commit that already contains the new bytes would
  // make every re-pin a chicken-and-egg deadlock. Any full 40-hex SHA of the commit
  // you are basing the change on is accepted, so pin and edit land together.
  if (typeof debtPin.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(debtPin.sourceCommit)) {
    return { ok: false, message: `${label}: debt pin sourceCommit must be a full lowercase Git SHA` };
  }
  if (typeof debtPin.reviewBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(debtPin.reviewBy)) {
    return { ok: false, message: `${label}: debt pin reviewBy must be an ISO date` };
  }
  const reviewDeadline = Date.parse(`${debtPin.reviewBy}T23:59:59.999Z`);
  if (!Number.isFinite(reviewDeadline) || now.getTime() > reviewDeadline) {
    return { ok: false, message: `${label}: source-bound debt pin expired on ${debtPin.reviewBy}` };
  }
  if (typeof debtPin.rationale !== 'string' || debtPin.rationale.trim().length < 20) {
    return { ok: false, message: `${label}: debt pin rationale must explain the retained debt` };
  }
  return { ok: true, pinnedLimit };
}

/**
 * Recursively collect `.ts` source files (excluding tests and declaration
 * files) under a directory, returned as package-relative POSIX paths.
 */
function collectSourceFiles(absDir, packageRoot, acc = []) {
  if (!existsSync(absDir)) return acc;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectSourceFiles(abs, packageRoot, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
    acc.push(path.relative(packageRoot, abs).split(path.sep).join('/'));
  }
  return acc;
}

/**
 * Per-file LOC ceiling for a package's source tree (MC-5 / DZUPAGENT-CODE-L-04).
 * Flags any source file over `maxFileLines` unless it has an exact
 * `fileLineDebtPins` entry. Every debt pin binds the accepted line count to the
 * file bytes, source commit, rationale, and finite review date, so later edits
 * fail closed instead of inheriting an open-ended exception.
 *
 * There is deliberately NO uncapped exemption. The former `fileLineAllowlist`
 * was a boolean escape hatch that skipped measurement entirely, letting pinned
 * files grow without limit while the gate stayed green
 * (RF-03 / DZUPAGENT-ARCH-H-07 + DZUPAGENT-CODE-H-06). It has been removed and
 * is now rejected outright so it cannot be reintroduced.
 */
function evaluateFileLineCeiling({ root, packageDir, budget, now }) {
  const messages = [];
  const debtPins = [];
  // Checked before the maxFileLines early-return so the removed key is rejected
  // even on a package that carries no per-file ceiling.
  if (budget.fileLineAllowlist !== undefined) {
    throw new Error(
      'fileLineAllowlist has been removed: it was an uncapped exemption that skipped measurement. '
      + 'Use fileLineDebtPins (source-hash + commit + reviewBy bound) instead.',
    );
  }
  const ceiling = budget.maxFileLines;
  if (ceiling === undefined) return { messages, debtPins };
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0) {
    throw new Error('maxFileLines budget must be a positive number');
  }
  const fileLineDebtPins = budget.fileLineDebtPins ?? {};
  if (typeof fileLineDebtPins !== 'object' || Array.isArray(fileLineDebtPins)) {
    throw new Error('fileLineDebtPins must be an object');
  }
  const srcDir = path.join(root, packageDir, 'src');
  for (const relFromPackage of collectSourceFiles(srcDir, path.join(root, packageDir))) {
    const sourceText = readText(path.join(root, packageDir, relFromPackage));
    const measured = countLines(sourceText);
    if (measured !== undefined && measured > ceiling) {
      const label = `${packageDir}/${relFromPackage}`;
      const pinResult = validateDebtPin({
        debtPin: fileLineDebtPins[relFromPackage],
        label,
        measured,
        metric: 'maxLines',
        sourceSha256: sha256(sourceText),
        now,
      });
      if (pinResult.ok) {
        debtPins.push({
          kind: 'file-lines',
          label,
          measured,
          target: ceiling,
          pinnedLimit: pinResult.pinnedLimit,
          reviewBy: fileLineDebtPins[relFromPackage].reviewBy,
          sourceCommit: fileLineDebtPins[relFromPackage].sourceCommit,
        });
        continue;
      }
      messages.push(
        `${packageDir}/${relFromPackage}: ${measured} LOC exceeds the ${ceiling}-LOC per-file ceiling. `
        + `Extract a cohesive sub-module (see MC-5 / DZUPAGENT-CODE-L-04). `
        + `${pinResult.message}.`,
      );
    }
  }
  return { messages, debtPins };
}

function packageDirFor(packageName) {
  // "@dzupagent/core" -> "packages/core"; bare names map to packages/<name>.
  const shortName = packageName.startsWith('@dzupagent/')
    ? packageName.slice('@dzupagent/'.length)
    : packageName;
  return path.join('packages', shortName);
}

export function measurePackageBarrel({ root, packageName }) {
  const packageDir = packageDirFor(packageName);
  const rootIndexPath = path.join(root, packageDir, 'src', 'index.ts');
  const rootIndexText = readText(rootIndexPath);

  return {
    packageDir,
    rootIndexExists: rootIndexText !== undefined,
    rootBarrel: summarizeRootBarrel(rootIndexText ?? ''),
    rootIndexLines: countLines(rootIndexText),
    rootIndexSha256: sha256(rootIndexText),
  };
}

function evaluateMetric({ messages, debtPins, packageName, metric, measured, limit,
  rootDebtPin, sourceSha256, now }) {
  if (limit === undefined) return;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
    throw new Error(`${packageName} ${metric} budget must be a non-negative number`);
  }
  if (measured === undefined) {
    messages.push(`${packageName}: ${metric} could not be measured (missing src/index.ts)`);
    return;
  }
  if (measured > limit) {
    const pinResult = validateDebtPin({
      debtPin: rootDebtPin,
      label: packageName,
      measured,
      metric,
      sourceSha256,
      now,
    });
    if (pinResult.ok) {
      debtPins.push({
        kind: 'root-barrel',
        label: packageName,
        metric,
        measured,
        target: limit,
        pinnedLimit: pinResult.pinnedLimit,
        reviewBy: rootDebtPin.reviewBy,
        sourceCommit: rootDebtPin.sourceCommit,
      });
      return;
    }
    messages.push(
      `${packageName}: ${metric} exceeded `
      + `(measured ${measured}, budget ${limit}). `
      + `Root barrels are growth-frozen — land new public API on a subpath export instead. `
      + `${pinResult.message}.`,
    );
  }
}

export function evaluateBarrelBudgets({ root, budgetConfig, now = new Date() }) {
  const packageBudgets = budgetConfig?.packages;
  if (!packageBudgets || typeof packageBudgets !== 'object' || Array.isArray(packageBudgets)) {
    throw new Error('Barrel budget file must contain a "packages" object');
  }

  const messages = [];
  const debtPins = [];
  const measurements = [];

  for (const [packageName, budget] of Object.entries(packageBudgets)) {
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
      throw new Error(`${packageName} barrel budget must be an object`);
    }

    const measurement = measurePackageBarrel({ root, packageName });
    measurements.push({ packageName, ...measurement });

    const hasBarrelBudget = ROOT_BARREL_METRICS
      && Object.keys(ROOT_BARREL_METRICS).some((metric) => budget[metric] !== undefined)
      || budget.maxRootIndexLines !== undefined;

    if (hasBarrelBudget) {
      for (const [metric, read] of Object.entries(ROOT_BARREL_METRICS)) {
        evaluateMetric({
          messages,
          debtPins,
          packageName,
          metric,
          measured: read(measurement.rootBarrel),
          limit: budget[metric],
          rootDebtPin: budget.rootDebtPin,
          sourceSha256: measurement.rootIndexSha256,
          now,
        });
      }

      evaluateMetric({
        messages,
        debtPins,
        packageName,
        metric: 'maxRootIndexLines',
        measured: measurement.rootIndexLines,
        limit: budget.maxRootIndexLines,
        rootDebtPin: budget.rootDebtPin,
        sourceSha256: measurement.rootIndexSha256,
        now,
      });
    }

    // Per-file LOC ceiling across the package src tree (MC-5).
    const fileLineResult = evaluateFileLineCeiling({
      root,
      packageDir: measurement.packageDir,
      budget,
      now,
    });
    messages.push(...fileLineResult.messages);
    debtPins.push(...fileLineResult.debtPins);

    const auxiliaryBudgets = budget.auxiliarySourceLineBudgets;
    if (auxiliaryBudgets !== undefined) {
      if (typeof auxiliaryBudgets !== 'object' || Array.isArray(auxiliaryBudgets)) {
        throw new Error(`${packageName} auxiliarySourceLineBudgets must be an object`);
      }
      for (const [relativeSource, limit] of Object.entries(auxiliaryBudgets)) {
        const measured = countLines(readText(path.join(root, measurement.packageDir, relativeSource)));
        evaluateMetric({
          messages,
          debtPins,
          packageName,
          metric: `${relativeSource} maxLines`,
          measured,
          limit,
          now,
        });
      }
    }
  }

  return {
    ok: messages.length === 0,
    messages,
    debtPins,
    measurements,
  };
}

function printReport(measurements) {
  for (const measurement of measurements) {
    console.log(`\n${measurement.packageName} (${measurement.packageDir})`);
    console.log(
      `  root barrel: ${measurement.rootBarrel.sourceCount} sources, `
      + `${measurement.rootBarrel.explicitExportCount} explicit exports, `
      + `${measurement.rootBarrel.starExportCount} star exports`,
    );
    console.log(`  src/index.ts: ${measurement.rootIndexLines ?? 'missing'} lines`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const root = process.cwd();
  const budgetPath = path.resolve(root, options.budgetFile);
  const budgetConfig = JSON.parse(readFileSync(budgetPath, 'utf8'));
  const result = evaluateBarrelBudgets({ root, budgetConfig });

  if (options.json) {
    console.log(JSON.stringify(
      { generatedAt: new Date().toISOString(), ...result },
      null,
      2,
    ));
    if (!options.report && !result.ok) process.exitCode = 1;
    return;
  }

  printReport(result.measurements);

  if (options.report) {
    return;
  }

  if (result.ok) {
    console.log('\nBarrel budgets: ok — no growth beyond targets or source-bound debt pins.');
    if (result.debtPins.length > 0) {
      console.log(`Source-bound debt pins accepted: ${result.debtPins.length}`);
      for (const pin of result.debtPins) {
        const metric = pin.metric === undefined ? '' : ` ${pin.metric}`;
        console.log(
          `  - ${pin.label}${metric}: ${pin.measured} > target ${pin.target}; `
          + `review by ${pin.reviewBy}`,
        );
      }
    }
    return;
  }

  console.error('\nBARREL BUDGET VIOLATIONS');
  console.error('========================');
  console.error('Public root barrels are growth-frozen to limit accidental coupling.');
  console.error('Land new public API on a documented subpath export instead of widening the root barrel.\n');
  for (const message of result.messages) {
    console.error(`  - ${message}`);
  }
  console.error('\nHow to fix:');
  console.error('  - Add the new module to an existing subpath export (see config/public-api-allowlists.json subpaths)');
  console.error('    and import it from that subpath, leaving the root barrel unchanged.');
  console.error('  - Do NOT lower a budget by removing/renaming a root export — that breaks published consumers.');
  console.error('  - If a deliberate relocation moved a cluster to a subpath (root re-export kept), the counts stay flat.');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
