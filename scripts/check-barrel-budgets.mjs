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

import { existsSync, readFileSync } from 'node:fs';
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
  };
}

function evaluateMetric({ messages, packageName, metric, measured, limit }) {
  if (limit === undefined) return;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
    throw new Error(`${packageName} ${metric} budget must be a non-negative number`);
  }
  if (measured === undefined) {
    messages.push(`${packageName}: ${metric} could not be measured (missing src/index.ts)`);
    return;
  }
  if (measured > limit) {
    messages.push(
      `${packageName}: ${metric} exceeded `
      + `(measured ${measured}, budget ${limit}). `
      + `Root barrels are growth-frozen — land new public API on a subpath export instead.`,
    );
  }
}

export function evaluateBarrelBudgets({ root, budgetConfig }) {
  const packageBudgets = budgetConfig?.packages;
  if (!packageBudgets || typeof packageBudgets !== 'object' || Array.isArray(packageBudgets)) {
    throw new Error('Barrel budget file must contain a "packages" object');
  }

  const messages = [];
  const measurements = [];

  for (const [packageName, budget] of Object.entries(packageBudgets)) {
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
      throw new Error(`${packageName} barrel budget must be an object`);
    }

    const measurement = measurePackageBarrel({ root, packageName });
    measurements.push({ packageName, ...measurement });

    for (const [metric, read] of Object.entries(ROOT_BARREL_METRICS)) {
      evaluateMetric({
        messages,
        packageName,
        metric,
        measured: read(measurement.rootBarrel),
        limit: budget[metric],
      });
    }

    evaluateMetric({
      messages,
      packageName,
      metric: 'maxRootIndexLines',
      measured: measurement.rootIndexLines,
      limit: budget.maxRootIndexLines,
    });

    const auxiliaryBudgets = budget.auxiliarySourceLineBudgets;
    if (auxiliaryBudgets !== undefined) {
      if (typeof auxiliaryBudgets !== 'object' || Array.isArray(auxiliaryBudgets)) {
        throw new Error(`${packageName} auxiliarySourceLineBudgets must be an object`);
      }
      for (const [relativeSource, limit] of Object.entries(auxiliaryBudgets)) {
        const measured = countLines(readText(path.join(root, measurement.packageDir, relativeSource)));
        evaluateMetric({
          messages,
          packageName,
          metric: `${relativeSource} maxLines`,
          measured,
          limit,
        });
      }
    }
  }

  return {
    ok: messages.length === 0,
    messages,
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
    console.log('\nBarrel budgets: ok — no root-barrel growth beyond the pinned baselines.');
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
