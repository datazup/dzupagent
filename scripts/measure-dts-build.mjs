import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PACKAGES = [
  '@dzupagent/agent',
  '@dzupagent/agent-adapters',
  '@dzupagent/codegen',
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

export function summarizeRootBarrel(rootIndexText) {
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

async function digestFileManifest(root, files) {
  const manifest = [];
  for (const file of [...files].sort()) {
    const content = await readFile(file);
    manifest.push({
      path: path.relative(root, file).split(path.sep).join('/'),
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

async function declarationInputSha256({ root, packageDir }) {
  const sourceRoot = path.join(root, packageDir, 'src');
  const sourceFiles = (await walkFiles(sourceRoot)).filter((file) => {
    const relative = path.relative(sourceRoot, file).split(path.sep).join('/');
    return file.endsWith('.ts')
      && !relative.includes('/__tests__/')
      && !relative.startsWith('__tests__/')
      && !/\.(?:test|spec)\.ts$/.test(relative);
  });
  const configurationFiles = ['package.json', 'tsconfig.json', 'tsup.config.ts']
    .map((file) => path.join(root, packageDir, file))
    .filter((file) => existsSync(file));
  return digestFileManifest(root, [...sourceFiles, ...configurationFiles]);
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
    declarationManifestSha256: await digestFileManifest(root, declarationFiles),
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

const DECLARATION_DEBT_METRICS = ['maxDeclarationFiles', 'maxDeclarationBytes'];
const APPROVAL_MAX_AGE_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;

function isHexDigest(value, length) {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

function validateIsoDate(value, label, messages) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    messages.push(`${label} must be an ISO date`);
    return undefined;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)
    || new Date(parsed).toISOString().slice(0, 10) !== value) {
    messages.push(`${label} must be an ISO date`);
    return undefined;
  }
  return parsed;
}

function validateDeclarationDebtPin({ result, budget, approvers, now }) {
  const pin = budget.declarationDebtPin;
  const messages = [];
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) {
    return { ok: false, messages: ['declarationDebtPin must be an object'] };
  }

  for (const metric of DECLARATION_DEBT_METRICS) {
    const measured = getMeasuredMetric(result, metric);
    if (pin[metric] !== measured) {
      messages.push(
        `declarationDebtPin ${metric} must equal the measured value ${measured} with zero slack`,
      );
    }
    if (typeof budget[metric] !== 'number' || pin[metric] <= budget[metric]) {
      messages.push(`declarationDebtPin ${metric} must remain above the enforced lower cap`);
    }
  }

  if (!isHexDigest(pin.declarationManifestSha256, 64)
    || pin.declarationManifestSha256 !== result.declarations.declarationManifestSha256) {
    messages.push('declarationDebtPin declaration manifest digest does not match reviewed output');
  }
  if (!isHexDigest(pin.declarationInputSha256, 64)
    || pin.declarationInputSha256 !== result.declarationInputSha256) {
    messages.push('declarationDebtPin declaration input digest does not match reviewed source');
  }
  if (!isHexDigest(pin.sourceCommit, 40)) {
    messages.push('declarationDebtPin sourceCommit must be a full lowercase Git commit');
  }
  if (typeof pin.rationale !== 'string' || pin.rationale.trim().length < 20) {
    messages.push('declarationDebtPin rationale must explain the temporary debt');
  }
  if (!Array.isArray(approvers) || approvers.length === 0) {
    messages.push('acceptedGrowthApprovers must be configured for declaration debt pins');
  } else if (typeof pin.approvedBy !== 'string' || !approvers.includes(pin.approvedBy)) {
    messages.push('declarationDebtPin approvedBy is not in acceptedGrowthApprovers');
  }

  const approvedOn = validateIsoDate(pin.approvedOn, 'declarationDebtPin approvedOn', messages);
  if (approvedOn !== undefined) {
    if (approvedOn > now.getTime()) {
      messages.push('declarationDebtPin approval is future-dated');
    } else if ((now.getTime() - approvedOn) / MILLISECONDS_PER_DAY > APPROVAL_MAX_AGE_DAYS) {
      messages.push(`declarationDebtPin approval is older than ${APPROVAL_MAX_AGE_DAYS} days`);
    }
  }
  const reviewBy = validateIsoDate(pin.reviewBy, 'declarationDebtPin reviewBy', messages);
  if (reviewBy !== undefined && reviewBy < Date.parse(now.toISOString().slice(0, 10))) {
    messages.push(`declarationDebtPin review expired on ${pin.reviewBy}`);
  }

  return { ok: messages.length === 0, messages, pin };
}

export function evaluateBudgets(results, budgetConfig, { now = new Date() } = {}) {
  const packageBudgets = budgetConfig?.packages;
  if (!packageBudgets || typeof packageBudgets !== 'object' || Array.isArray(packageBudgets)) {
    throw new Error('DTS budget file must contain a "packages" object');
  }

  const messages = [];
  const debtPins = [];
  const approvers = budgetConfig.acceptedGrowthApprovers;
  if (approvers !== undefined
    && (!Array.isArray(approvers)
      || approvers.some((entry) => typeof entry !== 'string' || entry.trim() === ''))) {
    throw new Error('acceptedGrowthApprovers must be an array of non-empty strings');
  }
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

    const declarationOverages = DECLARATION_DEBT_METRICS.filter((metric) => {
      const limit = budget[metric];
      const measured = getMeasuredMetric(result, metric);
      return typeof limit === 'number' && measured !== undefined && measured > limit;
    });
    let declarationDebt;
    if (declarationOverages.length > 0 && budget.declarationDebtPin !== undefined) {
      declarationDebt = validateDeclarationDebtPin({ result, budget, approvers, now });
      if (declarationDebt.ok) {
        debtPins.push({ packageName: result.name, ...declarationDebt.pin });
      } else {
        messages.push(...declarationDebt.messages.map((message) => `${result.name}: ${message}`));
      }
    } else if (declarationOverages.length === 0 && budget.declarationDebtPin !== undefined) {
      messages.push(`${result.name}: declarationDebtPin is stale because the lower caps are satisfied`);
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
        if (declarationDebt?.ok && DECLARATION_DEBT_METRICS.includes(metric)) {
          continue;
        }
        const isMinimum = isMinimumMetric(metric);
        const relation = isMinimum ? 'below minimum' : 'exceeded';
        // A minimum floor catches a dist that built JS but emitted no declarations,
        // which reads like accumulated debt and invites lowering the floor -- that
        // would disable the only check for a declaration-less publish. Name the
        // likely cause so the remedy is a rebuild, not a re-pin.
        const hint = isMinimum
          ? ' -- dist may be stale or partial; rebuild the package with'
            + ` \`npx turbo run build --filter=${result.name} --force\` before re-pinning`
          : '';
        messages.push(
          `${result.name}: ${metric} ${relation} `
          + `(measured ${formatBudgetValue(metric, measured)}, budget ${formatBudgetValue(metric, limit)})`
          + hint,
        );
      }
    }
  }

  return {
    ok: messages.length === 0,
    messages,
    debtPins,
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
      declarationInputSha256: await declarationInputSha256({ root, packageDir: pkg.dir }),
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
      if (budgetResult.debtPins.length > 0) {
        console.log(`Source-bound declaration debt pins accepted: ${budgetResult.debtPins.length}`);
      }
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
