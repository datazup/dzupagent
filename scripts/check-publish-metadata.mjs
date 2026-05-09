#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesDir = join(repoRoot, 'packages');
const expectedRepositoryUrl = 'git+https://github.com/datazup/dzupagent.git';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isPathEscapingPackage(target) {
  const normalized = normalize(target);
  return normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.startsWith('/');
}

function collectBinTargets(bin) {
  if (typeof bin === 'string') {
    return [['bin', bin]];
  }

  if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    return Object.entries(bin).filter(([, target]) => typeof target === 'string');
  }

  return [];
}

const failures = [];
let checkedPackages = 0;

for (const entry of readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;

  const packageDir = join(packagesDir, entry.name);
  const packageJsonPath = join(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) continue;

  const pkg = readJson(packageJsonPath);
  if (pkg.private === true) continue;

  checkedPackages += 1;

  const label = pkg.name ?? `packages/${entry.name}`;
  const repository = pkg.repository;
  const expectedDirectory = `packages/${entry.name}`;

  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    failures.push(`${label}: repository must be an object with type, url, and directory`);
  } else {
    if (repository.type !== 'git') {
      failures.push(`${label}: repository.type must be "git"`);
    }
    if (repository.url !== expectedRepositoryUrl) {
      failures.push(`${label}: repository.url must be ${expectedRepositoryUrl}`);
    }
    if (repository.directory !== expectedDirectory) {
      failures.push(`${label}: repository.directory must be ${expectedDirectory}`);
    }
  }

  for (const [binName, target] of collectBinTargets(pkg.bin)) {
    if (target.startsWith('./')) {
      failures.push(`${label}: bin[${binName}] must not start with "./"; npm 11 normalizes it away during publish`);
    }
    if (isPathEscapingPackage(target)) {
      failures.push(`${label}: bin[${binName}] must stay inside the package directory`);
      continue;
    }
    if (!existsSync(join(packageDir, target))) {
      failures.push(`${label}: bin[${binName}] target is missing after build: ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Publish metadata check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Publish metadata valid for ${checkedPackages} packages.`);
