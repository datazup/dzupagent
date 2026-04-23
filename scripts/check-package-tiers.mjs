import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const packagesDir = path.join(repoRoot, 'packages');
const configPath = path.join(repoRoot, 'config', 'package-tiers.json');

function fail(message) {
  console.error(`package-tiers: ${message}`);
  process.exitCode = 1;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function listWorkspacePackages() {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageJsonPath = path.join(packagesDir, entry.name, 'package.json');

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

async function main() {
  const packageMap = await readJson(configPath);
  const workspacePackages = await listWorkspacePackages();
  const workspaceNames = new Set(workspacePackages.map((pkg) => pkg.name));
  const manifestNames = new Set(Object.keys(packageMap));
  const validStatuses = new Set(['supported', 'supported-secondary', 'parked']);
  const validTiers = new Set([1, 2, 3]);

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

  if (process.exitCode) {
    return;
  }

  const counts = workspacePackages.reduce(
    (acc, pkg) => {
      acc[packageMap[pkg.name].tier] += 1;
      return acc;
    },
    { 1: 0, 2: 0, 3: 0 }
  );

  console.log(
    `package-tiers: ok (${workspacePackages.length} packages; tier1=${counts[1]}, tier2=${counts[2]}, tier3=${counts[3]})`
  );
}

await main();
