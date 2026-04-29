import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { checkPackageTiers } from '../check-package-tiers.mjs';

function makeRepo(structure) {
  const root = mkdtempSync(path.join(tmpdir(), 'dzupagent-package-tiers-'));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  mkdirSync(path.join(root, 'packages'), { recursive: true });

  writeFileSync(
    path.join(root, 'config', 'package-tiers.json'),
    JSON.stringify(structure.packageMap, null, 2),
  );

  if (structure.publicApiAllowlists) {
    writeFileSync(
      path.join(root, 'config', 'public-api-allowlists.json'),
      JSON.stringify(structure.publicApiAllowlists, null, 2),
    );
  }

  for (const [dirName, packageName] of Object.entries(structure.workspacePackages)) {
    const packageRoot = path.join(root, 'packages', dirName);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: packageName, private: true }, null, 2),
    );

    const sourceFiles = structure.sourceFiles?.[dirName] ?? {};
    for (const [relativePath, content] of Object.entries(sourceFiles)) {
      const filePath = path.join(packageRoot, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }
  }

  return root;
}

test('passes when package tier manifest matches the workspace', async () => {
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
    const result = await checkPackageTiers({ root: repoRoot });
    assert.equal(result.ok, true, result.messages.join('\n'));
    assert.equal(result.workspacePackages.length, 2);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('passes when governed root barrel exports match public API allowlist rules', async () => {
  const repoRoot = makeRepo({
    packageMap: {
      '@dzupagent/core': { tier: 1, status: 'supported', roadmapDriver: true, owners: ['help'] },
    },
    workspacePackages: {
      core: '@dzupagent/core',
    },
    publicApiAllowlists: {
      packages: [
        {
          packageName: '@dzupagent/core',
          packageDir: 'packages/core',
          rootIndex: 'packages/core/src/index.ts',
          stableRoot: [{ match: 'prefix', pattern: './stable/' }],
          transitionalRoot: [{ match: 'exact', pattern: './advanced/runtime.js' }],
        },
      ],
    },
    sourceFiles: {
      core: {
        'src/index.ts': `
          export { createStableThing } from './stable/thing.js'
          export type { AdvancedRuntime } from './advanced/runtime.js'
        `,
      },
    },
  });

  try {
    const result = await checkPackageTiers({ root: repoRoot });
    assert.equal(result.ok, true, result.messages.join('\n'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('fails when a governed root barrel export is not explicitly allowlisted', async () => {
  const repoRoot = makeRepo({
    packageMap: {
      '@dzupagent/core': { tier: 1, status: 'supported', roadmapDriver: true, owners: ['help'] },
    },
    workspacePackages: {
      core: '@dzupagent/core',
    },
    publicApiAllowlists: {
      packages: [
        {
          packageName: '@dzupagent/core',
          packageDir: 'packages/core',
          rootIndex: 'packages/core/src/index.ts',
          stableRoot: [{ match: 'prefix', pattern: './stable/' }],
          transitionalRoot: [],
        },
      ],
    },
    sourceFiles: {
      core: {
        'src/index.ts': `
          export { createStableThing } from './stable/thing.js'
          export { createPreviewThing } from './preview/thing.js'
        `,
      },
    },
  });

  try {
    const result = await checkPackageTiers({ root: repoRoot });
    assert.equal(result.ok, false);
    assert.match(result.messages.join('\n'), /config\/public-api-allowlists\.json stableRoot or transitionalRoot/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('fails when the manifest omits a workspace package', async () => {
  const repoRoot = makeRepo({
    packageMap: {},
    workspacePackages: {
      alpha: '@dzupagent/alpha',
    },
  });

  try {
    const result = await checkPackageTiers({ root: repoRoot });
    assert.equal(result.ok, false);
    assert.match(result.messages.join('\n'), /missing manifest entry for @dzupagent\/alpha/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('fails when tier rules are inconsistent', async () => {
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
    const result = await checkPackageTiers({ root: repoRoot });
    assert.equal(result.ok, false);
    assert.match(
      result.messages.join('\n'),
      /Tier 1 but has no owning consumers|Tier 3 and must use status "parked"|Tier 3 and cannot be a roadmap driver/,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
