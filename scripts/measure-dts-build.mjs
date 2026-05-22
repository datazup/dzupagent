import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PACKAGES = [
  '@dzupagent/agent',
  '@dzupagent/agent-adapters',
  '@dzupagent/codegen',
  '@dzupagent/flow-dsl',
  '@dzupagent/server',
];

const DEFAULT_BUDGET_FILE = 'scripts/dts-budgets.json';

function parseArgs(argv) {
  const options = {
    build: false,
    check: false,
    json: false,
    budgetFile: DEFAULT_BUDGET_FILE,
    packages: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--build') {
      options.build = true;
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

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/measure-dts-build.mjs [options] [package...]

Measures declaration-output size and, with --build, package build duration.

Options:
  --package <name[,name]>  Package name or packages/<dir> path to measure
  --build                 Run yarn workspace <pkg> build before measuring
  --check                 Fail when measured output exceeds DTS budgets
  --budget-file <path>    Budget file for --check (default: ${DEFAULT_BUDGET_FILE})
  --json                  Print machine-readable JSON
  -h, --help              Show this help

Default packages: ${DEFAULT_PACKAGES.join(', ')}`);
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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function printText(results) {
  for (const result of results) {
    console.log(`\n${result.name} (${result.dir})`);
    if (result.buildDurationMs !== undefined) {
      console.log(`  build: ${(result.buildDurationMs / 1000).toFixed(2)}s`);
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
      return result.buildDurationMs;
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

    const buildDurationMs = options.build ? await runBuild(pkg.name) : undefined;
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
      buildDurationMs,
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
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results, budgetResult }, null, 2));
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
