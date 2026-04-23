import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  generatePackageSupportIndex,
  readPackageSupportEntries,
} from '../generate-package-support-index.mjs';

function makeRepo(structure) {
  const root = mkdtempSync(path.join(tmpdir(), 'dzupagent-support-index-'));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, 'packages'), { recursive: true });

  writeFileSync(
    path.join(root, 'config', 'package-tiers.json'),
    JSON.stringify(structure.packageMap, null, 2),
  );

  for (const [dirName, pkg] of Object.entries(structure.packages)) {
    const packageRoot = path.join(root, 'packages', dirName);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: pkg.name, private: true }, null, 2),
    );
  }

  return root;
}

test('readPackageSupportEntries maps package tiers and sorts by tier then name', () => {
  const repoRoot = makeRepo({
    packageMap: {
      '@dzupagent/zeta': { tier: 2, status: 'supported-secondary', roadmapDriver: false, owners: [] },
      '@dzupagent/alpha': { tier: 1, status: 'supported', roadmapDriver: true, owners: ['help'] },
    },
    packages: {
      zeta: { name: '@dzupagent/zeta' },
      alpha: { name: '@dzupagent/alpha' },
    },
  });

  try {
    const entries = readPackageSupportEntries({ repoRoot });
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.tier]),
      [
        ['@dzupagent/alpha', 1],
        ['@dzupagent/zeta', 2],
      ],
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('generatePackageSupportIndex writes the provided generation date and unmapped packages', () => {
  const repoRoot = makeRepo({
    packageMap: {
      '@dzupagent/alpha': { tier: 1, status: 'supported', roadmapDriver: true, owners: ['help'] },
    },
    packages: {
      alpha: { name: '@dzupagent/alpha' },
      beta: { name: '@dzupagent/beta' },
    },
  });

  try {
    const result = generatePackageSupportIndex({
      repoRoot,
      generatedOn: '2026-04-23',
    });

    const written = readFileSync(result.outputPath, 'utf8');
    assert.match(written, /^# Package Support Index/m);
    assert.match(written, /Date: 2026-04-23/);
    assert.match(written, /`@dzupagent\/alpha`/);
    assert.match(written, /`@dzupagent\/beta`/);
    assert.match(written, /`unmapped`/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
