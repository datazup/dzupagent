import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../check-package-tiers.mjs', import.meta.url));

function makeRepo(structure) {
  const root = mkdtempSync(path.join(tmpdir(), 'dzupagent-package-tiers-'));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  mkdirSync(path.join(root, 'packages'), { recursive: true });

  writeFileSync(
    path.join(root, 'config', 'package-tiers.json'),
    JSON.stringify(structure.packageMap, null, 2),
  );

  for (const [dirName, packageName] of Object.entries(structure.workspacePackages)) {
    const packageRoot = path.join(root, 'packages', dirName);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: packageName, private: true }, null, 2),
    );
  }

  return root;
}

test('passes when package tier manifest matches the workspace', () => {
  const repoRoot = makeRepo({
    packageMap: {
      '@dzupagent/alpha': { tier: 1, status: 'supported', roadmapDriver: true, owners: ['help'] },
      '@dzupagent/beta': { tier: 3, status: 'parked', roadmapDriver: false, owners: [] },
    },
    workspacePackages: {
      alpha: '@dzupagent/alpha',
      beta: '@dzupagent/beta',
    },
  });

  try {
    const output = execFileSync('node', [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(output, /package-tiers: ok/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('fails when the manifest omits a workspace package', () => {
  const repoRoot = makeRepo({
    packageMap: {},
    workspacePackages: {
      alpha: '@dzupagent/alpha',
    },
  });

  try {
    assert.throws(
      () =>
        execFileSync('node', [scriptPath], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      /missing manifest entry for @dzupagent\/alpha/,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('fails when tier rules are inconsistent', () => {
  const repoRoot = makeRepo({
    packageMap: {
      '@dzupagent/alpha': { tier: 1, status: 'supported', roadmapDriver: true, owners: [] },
      '@dzupagent/beta': { tier: 3, status: 'supported-secondary', roadmapDriver: true, owners: [] },
    },
    workspacePackages: {
      alpha: '@dzupagent/alpha',
      beta: '@dzupagent/beta',
    },
  });

  try {
    assert.throws(
      () =>
        execFileSync('node', [scriptPath], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      /Tier 1 but has no owning consumers|Tier 3 and must use status "parked"|Tier 3 and cannot be a roadmap driver/,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
