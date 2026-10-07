#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, sep, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedRepositoryUrl = 'git+https://github.com/datazup/dzupagent.git';

export function readSourceManifest(root, manifestPath, sourceCommit) {
  if (!sourceCommit) return JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Publish metadata source must be a full commit');
  const path = relative(root, manifestPath).split(sep).join('/');
  if (!/^packages\/[a-z0-9-]+\/package\.json$/.test(path)) throw new Error('Invalid package manifest path');
  return JSON.parse(execFileSync('git', ['show', sourceCommit + ':' + path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
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

export function checkPublishMetadata(root = repoRoot, sourceCommit) {
const packagesDir = join(root, 'packages');
const failures = [];
const metadataDrift = [];
let checkedPackages = 0;

for (const entry of readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;

  const packageDir = join(packagesDir, entry.name);
  const packageJsonPath = join(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) continue;

  const pkg = readSourceManifest(root, packageJsonPath, sourceCommit);
  if (sourceCommit && JSON.stringify(pkg) !== JSON.stringify(JSON.parse(readFileSync(packageJsonPath, 'utf8')))) metadataDrift.push(entry.name);
  if (pkg.private === true) continue;

  checkedPackages += 1;

  const label = pkg.name ?? `packages/${entry.name}`;
  const repository = pkg.repository;
  const expectedDirectory = `packages/${entry.name}`;

  if (typeof pkg.bin === 'string') {
    failures.push(`${label}: bin must be an object so npm 11 does not normalize package metadata during publish`);
  }

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

return { failures, checkedPackages, metadataDrift, sourceCommit: sourceCommit ?? null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const at = process.argv.indexOf('--source-commit');
    if (at !== -1 && !process.argv[at + 1]) throw new Error('Missing --source-commit value');
    const report = checkPublishMetadata(repoRoot, at === -1 ? undefined : process.argv[at + 1]);
    if (report.metadataDrift.length) console.log('Working-tree metadata differs from immutable source: ' + report.metadataDrift.join(', '));
    if (report.failures.length) {
      console.error('Publish metadata check failed:\n' + report.failures.join('\n'));
      process.exitCode = 1;
    } else console.log(`Publish metadata valid for ${report.checkedPackages} packages (source: ${report.sourceCommit ?? 'working tree'}).`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
