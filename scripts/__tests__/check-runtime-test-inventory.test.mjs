import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { isTrueIntegrationTestFile, runRuntimeTestInventory } from '../check-runtime-test-inventory.mjs';

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

    if (pkg.testFileContents) {
      for (const [relativeFile, contents] of Object.entries(pkg.testFileContents)) {
        const filePath = path.join(packageRoot, relativeFile);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, contents);
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

test('strict mode counts integration-style files under top-level test directories (filename tally only)', () => {
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

    assert.equal(entry?.testCount, 1);
    assert.equal(entry?.integrationStyleTestCount, 1);
    // DZUPAGENT-TEST-H-02: an integration-flavoured filename with no real
    // external-service marker in its contents must NOT count as a true
    // integration suite, and the strict gate must fail for this
    // runtime-critical package as a result.
    assert.equal(entry?.trueIntegrationTestCount, 0);
    assert.equal(report.exitCode, 1);
    assert.equal(report.integrationFailing.length, 1);
    assert.equal(report.integrationFailing[0].name, 'core');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('strict mode passes when a suite actually references the fail-closed integration gate', () => {
  const repoRoot = makeRepo({
    packages: {
      core: {
        testFileContents: {
          'src/__tests__/postgres.integration.test.ts': [
            "import { requireIntegration } from '@dzupagent/test-utils'",
            "const gate = requireIntegration({ name: 'x', available: false, reason: 'no docker' })",
            "describe.skipIf(gate.shouldSkip)('x', () => {})",
          ].join('\n'),
        },
      },
    },
  });

  try {
    const report = runRuntimeTestInventory({ repoRoot, strictIntegration: true });
    const entry = report.summary.find((row) => row.name === 'core');

    assert.equal(entry?.trueIntegrationTestCount, 1);
    assert.equal(report.exitCode, 0);
    assert.equal(report.integrationFailing.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('strict mode does not count a mocked suite that merely mentions a service name in its filename', () => {
  const repoRoot = makeRepo({
    packages: {
      core: {
        testFileContents: {
          // Filename looks like a real Postgres integration suite, but the
          // body only uses in-memory/mock fixtures — no fail-closed gate.
          'src/__tests__/postgres-store.integration.test.ts': [
            "import { vi } from 'vitest'",
            "const createClient = () => ({ query: vi.fn() })",
            "describe('mocked postgres store', () => {})",
          ].join('\n'),
        },
      },
    },
  });

  try {
    const report = runRuntimeTestInventory({ repoRoot, strictIntegration: true });
    const entry = report.summary.find((row) => row.name === 'core');

    assert.equal(entry?.integrationStyleTestCount, 1, 'filename-based tally still counts it');
    assert.equal(entry?.trueIntegrationTestCount, 0, 'behavior-based tally excludes the mocked suite');
    assert.equal(report.exitCode, 1);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('isTrueIntegrationTestFile matches the shared fail-closed gate markers', () => {
  assert.equal(isTrueIntegrationTestFile("requireIntegration({ name: 'x' })"), true);
  assert.equal(isTrueIntegrationTestFile("requireIntegrationEnv('x', 'TEST_DATABASE_URL')"), true);
  assert.equal(isTrueIntegrationTestFile('skipOrFailIfNoDatabase()'), true);
  assert.equal(isTrueIntegrationTestFile('skipOrFailIfNoRedis()'), true);
  assert.equal(isTrueIntegrationTestFile('skipOrFailIfNoContainerRuntime(true)'), true);
  assert.equal(isTrueIntegrationTestFile('if (process.env.RUN_REQUIRED_INTEGRATION) throw new Error("x")'), true);
});

test('isTrueIntegrationTestFile does not match mocked suites that merely reference service names', () => {
  assert.equal(isTrueIntegrationTestFile("const createClient = () => ({ query: vi.fn() })"), false);
  assert.equal(isTrueIntegrationTestFile("QDRANT_URL: 'http://localhost:6333'"), false);
  assert.equal(isTrueIntegrationTestFile("describe('postgres store (mocked)', () => {})"), false);
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

test('reports large production files without direct or declared coverage as risk inventory', () => {
  const repoRoot = makeRepo({
    packages: {
      core: {
        sourceFiles: ['src/runtime/large-contract.ts'],
        testFiles: ['src/__tests__/other.test.ts'],
      },
    },
    config: {
      largeSourceFileRisk: {
        minLines: 3,
      },
    },
  });

  writeFileSync(
    path.join(repoRoot, 'packages', 'core', 'src', 'runtime', 'large-contract.ts'),
    ['export const a = 1;', 'export const b = 2;', 'export const c = 3;'].join('\n'),
  );

  try {
    const report = runRuntimeTestInventory({ repoRoot });
    assert.equal(report.exitCode, 0);
    assert.equal(report.largeSourceFileRisks.length, 1);
    assert.equal(report.largeSourceFileRisks[0].sourcePath, 'src/runtime/large-contract.ts');
    assert.match(report.largeSourceFileRisks[0].message, /no direct or declared test coverage/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('does not report large production files with declared critical source coverage', () => {
  const repoRoot = makeRepo({
    packages: {
      core: {
        sourceFiles: ['src/runtime/large-contract.ts'],
        testFiles: ['src/__tests__/large-contract.test.ts'],
      },
    },
    config: {
      largeSourceFileRisk: {
        minLines: 3,
      },
      criticalSourceFiles: [
        {
          package: 'core',
          path: 'src/runtime/large-contract.ts',
          coveredBy: ['src/__tests__/large-contract.test.ts'],
        },
      ],
    },
  });

  writeFileSync(
    path.join(repoRoot, 'packages', 'core', 'src', 'runtime', 'large-contract.ts'),
    ['export const a = 1;', 'export const b = 2;', 'export const c = 3;'].join('\n'),
  );

  try {
    const report = runRuntimeTestInventory({ repoRoot });
    assert.equal(report.exitCode, 0);
    assert.equal(report.largeSourceFileRisks.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
