import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../check-runtime-test-inventory.mjs', import.meta.url));

function makeRepo(structure) {
  const root = mkdtempSync(path.join(tmpdir(), 'dzupagent-runtime-inventory-'));
  mkdirSync(path.join(root, 'packages'), { recursive: true });

  for (const [dirName, pkg] of Object.entries(structure.packages)) {
    const packageRoot = path.join(root, 'packages', dirName);
    mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
    writeFileSync(path.join(packageRoot, 'src', 'index.ts'), 'export {};');

    if (pkg.testFiles) {
      for (const relativeFile of pkg.testFiles) {
        const filePath = path.join(packageRoot, relativeFile);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, 'export {};');
      }
    }
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
    const output = execFileSync('node', [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.match(output, /flow-compiler: 1 test file/);
    assert.match(output, /Zero-test runtime package gate passed/);
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
    const output = execFileSync('node', [scriptPath, '--strict-integration'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.match(output, /core: 1 test file, 1 integration-style test/);
    assert.match(output, /Strict integration-style runtime package gate passed/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
