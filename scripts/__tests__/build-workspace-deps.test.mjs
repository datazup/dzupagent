import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  collectWorkspaceDependencyBuildFilters,
  buildTurboBuildArgs,
} from '../build-workspace-deps.mjs';

function writeJson(root, pathname, value) {
  const filePath = path.join(root, pathname);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'dzupagent-workspace-deps-'));
  writeJson(root, 'package.json', {
    workspaces: ['packages/*'],
  });
  return root;
}

test('collects direct local workspace dependency filters for a package typecheck', () => {
  const root = makeRepo();
  try {
    writeJson(root, 'packages/agent-adapters/package.json', {
      name: '@dzupagent/agent-adapters',
      dependencies: {
        '@dzupagent/core': '0.2.0',
        '@dzupagent/subagents': '0.1.0',
        zod: '^4.0.0',
      },
      devDependencies: {
        '@dzupagent/adapter-types': '0.2.0',
      },
    });
    writeJson(root, 'packages/core/package.json', { name: '@dzupagent/core' });
    writeJson(root, 'packages/subagents/package.json', {
      name: '@dzupagent/subagents',
    });
    writeJson(root, 'packages/adapter-types/package.json', {
      name: '@dzupagent/adapter-types',
    });

    assert.deepEqual(
      collectWorkspaceDependencyBuildFilters(root, '@dzupagent/agent-adapters'),
      [
        '@dzupagent/adapter-types',
        '@dzupagent/core',
        '@dzupagent/subagents',
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('builds a turbo command that targets only dependency builds', () => {
  assert.deepEqual(
    buildTurboBuildArgs(['@dzupagent/core', '@dzupagent/subagents']),
    [
      'turbo',
      'run',
      'build',
      '--filter=@dzupagent/core',
      '--filter=@dzupagent/subagents',
    ],
  );
});
