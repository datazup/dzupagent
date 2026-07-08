import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

export function collectWorkspaceDependencyBuildFilters(root, packageName) {
  const packages = readWorkspacePackages(root);
  const target = packages.get(packageName);
  if (target === undefined) {
    throw new Error(`Workspace package "${packageName}" was not found`);
  }

  const filters = new Set();
  for (const section of dependencySections) {
    const dependencies = target.packageJson[section] ?? {};
    for (const dependencyName of Object.keys(dependencies)) {
      if (packages.has(dependencyName)) {
        filters.add(dependencyName);
      }
    }
  }

  return [...filters].sort();
}

export function buildTurboBuildArgs(filters) {
  return [
    'turbo',
    'run',
    'build',
    ...filters.map((filter) => `--filter=${filter}`),
  ];
}

function readWorkspacePackages(root) {
  const packagesRoot = path.join(root, 'packages');
  const packages = new Map();
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageJsonPath = path.join(packagesRoot, entry.name, 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (typeof packageJson.name === 'string') {
      packages.set(packageJson.name, { packageJson, packageJsonPath });
    }
  }
  return packages;
}

function packageNameFromCwd() {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      'Package name argument is required when the current directory has no package.json',
    );
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (typeof packageJson.name !== 'string') {
    throw new Error(`package.json at ${packageJsonPath} has no package name`);
  }
  return packageJson.name;
}

function main() {
  const packageName = process.argv[2] ?? packageNameFromCwd();
  const filters = collectWorkspaceDependencyBuildFilters(repoRoot, packageName);
  if (filters.length === 0) {
    console.log(`OK: ${packageName} has no local workspace dependencies to build`);
    return;
  }

  const args = buildTurboBuildArgs(filters);
  console.log(`Building local dependencies for ${packageName}: ${filters.join(', ')}`);
  const result = spawnSync('yarn', args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
