import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readJsonIfExists(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }

  return readJson(filePath);
}

function parseExportNames(spec) {
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\s+as\s+\w+$/, '').replace(/^type\s+/, '').trim());
}

function summarizeRootExportSources(indexText) {
  const bySource = new Map();
  const exportBlockRe = /export(?:\s+type)?\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
  const exportStarRe = /export(?:\s+type)?\s+\*\s+from\s*['"]([^'"]+)['"]/g;

  let match;
  while ((match = exportBlockRe.exec(indexText)) !== null) {
    const source = match[2];
    const current = bySource.get(source) ?? new Set();
    for (const exportName of parseExportNames(match[1])) {
      current.add(exportName);
    }
    bySource.set(source, current);
  }

  while ((match = exportStarRe.exec(indexText)) !== null) {
    const source = match[1];
    const current = bySource.get(source) ?? new Set();
    current.add('*');
    bySource.set(source, current);
  }

  for (const localMatch of indexText.matchAll(/export\s+const\s+(\w+)\s*=/g)) {
    const source = `<local>:${localMatch[1]}`;
    const current = bySource.get(source) ?? new Set();
    current.add(localMatch[1]);
    bySource.set(source, current);
  }

  return [...bySource.entries()].map(([source, exportNames]) => ({
    source,
    exportNames: [...exportNames],
  }));
}

function ruleMatches(source, rule) {
  if (rule.match === 'exact') return source === rule.pattern;
  if (rule.match === 'prefix') return source.startsWith(rule.pattern);
  return false;
}

function classifyRootSource(source, packageConfig) {
  const stableMatches = (packageConfig.stableRoot ?? []).filter((rule) => ruleMatches(source, rule));
  if (stableMatches.length > 0) {
    return {
      rootClass: 'stable',
      matches: stableMatches,
    };
  }

  const transitionalMatches = (packageConfig.transitionalRoot ?? []).filter((rule) => ruleMatches(source, rule));
  if (transitionalMatches.length > 0) {
    return {
      rootClass: 'deprecated-transitional',
      matches: transitionalMatches,
    };
  }

  return {
    rootClass: 'unreviewed',
    matches: [],
  };
}

async function listWorkspacePackages(root) {
  const entries = await readdir(path.join(root, 'packages'), { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageJsonPath = path.join(root, 'packages', entry.name, 'package.json');

    try {
      const packageJson = await readJson(packageJsonPath);
      packages.push({
        dir: entry.name,
        name: packageJson.name
      });
    } catch {
      // Skip directories that do not contain a readable package.json.
    }
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

export async function checkPackageTiers({ root = process.cwd() } = {}) {
  const configPath = path.join(root, 'config', 'package-tiers.json');
  const publicApiAllowlistsPath = path.join(root, 'config', 'public-api-allowlists.json');
  const packageMap = await readJson(configPath);
  const publicApiAllowlists = await readJsonIfExists(publicApiAllowlistsPath, { packages: [] });
  const workspacePackages = await listWorkspacePackages(root);
  const workspaceNames = new Set(workspacePackages.map((pkg) => pkg.name));
  const manifestNames = new Set(Object.keys(packageMap));
  const validStatuses = new Set(['supported', 'supported-secondary', 'parked']);
  const validTiers = new Set([1, 2, 3]);
  const messages = [];

  function fail(message) {
    messages.push(message);
  }

  for (const pkg of workspacePackages) {
    if (!manifestNames.has(pkg.name)) {
      fail(`missing manifest entry for ${pkg.name}`);
    }
  }

  for (const manifestName of manifestNames) {
    if (!workspaceNames.has(manifestName)) {
      fail(`manifest entry ${manifestName} does not match a package in packages/*`);
      continue;
    }

    const entry = packageMap[manifestName];

    if (!validTiers.has(entry.tier)) {
      fail(`${manifestName} has invalid tier ${String(entry.tier)}`);
    }

    if (!validStatuses.has(entry.status)) {
      fail(`${manifestName} has invalid status ${String(entry.status)}`);
    }

    if (!Array.isArray(entry.owners)) {
      fail(`${manifestName} must define owners as an array`);
    }

    if (typeof entry.roadmapDriver !== 'boolean') {
      fail(`${manifestName} must define roadmapDriver as a boolean`);
    }

    if (entry.tier === 1 && entry.owners.length === 0) {
      fail(`${manifestName} is Tier 1 but has no owning consumers`);
    }

    if (entry.tier === 3 && entry.status !== 'parked') {
      fail(`${manifestName} is Tier 3 and must use status "parked"`);
    }

    if (entry.tier === 3 && entry.roadmapDriver) {
      fail(`${manifestName} is Tier 3 and cannot be a roadmap driver`);
    }
  }

  for (const packageConfig of publicApiAllowlists.packages ?? []) {
    if (!manifestNames.has(packageConfig.packageName)) {
      fail(`${packageConfig.packageName} has public API allowlist rules but no config/package-tiers.json entry`);
      continue;
    }

    const packageTier = packageMap[packageConfig.packageName];
    if (packageTier.tier !== 1) {
      fail(
        `${packageConfig.packageName} has root-barrel public API allowlist rules but is Tier ${packageTier.tier}; ` +
          `update config/package-tiers.json before treating its root barrel as governed public API`
      );
    }

    const rootIndexPath = path.join(root, packageConfig.rootIndex);
    const rootIndexText = await readFile(rootIndexPath, 'utf8');
    const sources = summarizeRootExportSources(rootIndexText);

    for (const { source, exportNames } of sources) {
      const classification = classifyRootSource(source, packageConfig);

      if (classification.matches.length === 0) {
        const sampleExports = exportNames.slice(0, 5).join(', ');
        fail(
          `${packageConfig.packageName} root export source ${source} is not reviewed (${sampleExports}). ` +
            `Intentional root exports must be added to config/public-api-allowlists.json stableRoot or transitionalRoot; ` +
            `if this package tier changed, update config/package-tiers.json. Prefer a stable or advanced subpath export for newly exposed APIs.`
        );
      }

      if (classification.matches.length > 1) {
        const formatted = classification.matches.map((rule) => `${rule.match}:${rule.pattern}`).join(', ');
        fail(
          `${packageConfig.packageName} root export source ${source} matches multiple public API allowlist rules: ${formatted}`
        );
      }
    }
  }

  if (messages.length > 0) {
    return {
      ok: false,
      messages,
      workspacePackages,
    };
  }

  const counts = workspacePackages.reduce(
    (acc, pkg) => {
      acc[packageMap[pkg.name].tier] += 1;
      return acc;
    },
    { 1: 0, 2: 0, 3: 0 }
  );

  return {
    ok: true,
    messages,
    workspacePackages,
    counts,
  };
}

async function main() {
  const result = await checkPackageTiers();

  if (!result.ok) {
    for (const message of result.messages) {
      console.error(`package-tiers: ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `package-tiers: ok (${result.workspacePackages.length} packages; tier1=${result.counts[1]}, tier2=${result.counts[2]}, tier3=${result.counts[3]})`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
