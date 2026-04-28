import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { runRuntimeTestInventory } from '../check-runtime-test-inventory.mjs';

function makeRepo(structure) {
  const root = mkdtempSync(path.join(tmpdir(), 'dzupagent-runtime-inventory-'));
  mkdirSync(path.join(root, 'packages'), { recursive: true });

  for (const [dirName, pkg] of Object.entries(structure.packages)) {
    const packageRoot = path.join(root, 'packages', dirName);
    mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
    writeFileSync(path.join(packageRoot, 'src', 'index.ts'), 'export {};');

    if (pkg.sourceFiles) {
      for (const relativeFile of pkg.sourceFiles) {
        const filePath = path.join(packageRoot, relativeFile);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, 'export {};');
      }
    }

    if (pkg.testFiles) {
      for (const relativeFile of pkg.testFiles) {
        const filePath = path.join(packageRoot, relativeFile);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, 'export {};');
      }
    }
  }

  if (structure.config) {
    writeFileSync(
      path.join(root, 'coverage-thresholds.json'),
      JSON.stringify(structure.config, null, 2),
    );
  }

  return root;
}

test('counts top-level test directory files toward runtime package inventory', () => {
  const repoRoot = makeRepo({
    packages: {
      'flow-compiler': {
        testFiles: ['test/compile.test.ts'],
      },
    },
  });

  try {
    const report = runRuntimeTestInventory({ repoRoot });
    const entry = report.summary.find((row) => row.name === 'flow-compiler');

    assert.equal(report.exitCode, 0);
    assert.equal(entry?.testCount, 1);
    assert.equal(report.zeroTestFailing.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('strict mode counts integration-style files under top-level test directories', () => {
  const repoRoot = makeRepo({
    packages: {
      core: {
        testFiles: ['test/integration/runtime.integration.test.ts'],
      },
    },
  });

  try {
    const report = runRuntimeTestInventory({ repoRoot, strictIntegration: true });
    const entry = report.summary.find((row) => row.name === 'core');

    assert.equal(report.exitCode, 0);
    assert.equal(entry?.testCount, 1);
    assert.equal(entry?.integrationStyleTestCount, 1);
    assert.equal(report.integrationFailing.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('passes critical source files with declared test coverage', () => {
  const repoRoot = makeRepo({
    packages: {
      core: {
        sourceFiles: ['src/security/policy-engine.ts'],
        testFiles: ['src/__tests__/policy-engine.test.ts'],
      },
    },
    config: {
      criticalSourceFiles: [
        {
          package: 'core',
          path: 'src/security/policy-engine.ts',
          coveredBy: ['src/__tests__/policy-engine.test.ts'],
        },
      ],
    },
  });

  try {
    const report = runRuntimeTestInventory({ repoRoot });
    const entry = report.criticalSourceCoverage[0];

    assert.equal(report.exitCode, 0);
    assert.equal(entry.status, 'pass');
    assert.match(entry.message, /declared coverage via src\/__tests__\/policy-engine.test.ts/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('fails critical source files without direct, declared, or waived coverage', () => {
  const repoRoot = makeRepo({
    packages: {
      core: {
        sourceFiles: ['src/security/policy-engine.ts'],
        testFiles: ['src/__tests__/other.test.ts'],
      },
    },
    config: {
      criticalSourceFiles: [
        {
          package: 'core',
          path: 'src/security/policy-engine.ts',
        },
      ],
    },
  });

  try {
    const report = runRuntimeTestInventory({ repoRoot });
    assert.equal(report.exitCode, 1);
    assert.equal(report.criticalSourceFailing.length, 1);
    assert.match(report.criticalSourceFailing[0].message, /missing direct or declared test coverage/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('honors critical source waivers with reasons', () => {
  const repoRoot = makeRepo({
    packages: {
      core: {
        sourceFiles: ['src/security/policy-engine.ts'],
        testFiles: ['src/__tests__/other.test.ts'],
      },
    },
    config: {
      criticalSourceFiles: [
        {
          package: 'core',
          path: 'src/security/policy-engine.ts',
          waiver: {
            reason: 'covered by higher-level security policy integration suite in the next baseline',
            until: '2099-01-01',
          },
        },
      ],
    },
  });

  try {
    const report = runRuntimeTestInventory({ repoRoot });
    const entry = report.criticalSourceCoverage[0];

    assert.equal(report.exitCode, 0);
    assert.equal(entry.status, 'waived');
    assert.match(entry.message, /waived until 2099-01-01: covered by higher-level security policy integration suite/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
