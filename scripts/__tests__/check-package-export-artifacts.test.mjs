import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { checkPackageExportArtifacts } from '../check-package-export-artifacts.mjs';

function writeText(root, pathname, content) {
  const filePath = path.join(root, pathname);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'dzupagent-export-artifacts-'));
  mkdirSync(path.join(root, 'packages'), { recursive: true });
  return root;
}

function writePackage(root, packageDir, packageJson, files = {}) {
  const packageRoot = path.join(root, packageDir);
  mkdirSync(packageRoot, { recursive: true });
  writeText(root, path.join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  for (const [relativePath, content] of Object.entries(files)) {
    writeText(root, path.join(packageDir, relativePath), content);
  }
}

test('passes when package exports point to existing runtime and declaration artifacts', async () => {
  const root = makeRepo();
  try {
    writePackage(
      root,
      'packages/core',
      {
        name: '@dzupagent/core',
        types: 'dist/index.d.ts',
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
          },
          './identity': {
            import: './dist/identity.js',
            types: './dist/identity.d.ts',
          },
        },
      },
      {
        'dist/index.js': 'export {}\n',
        'dist/index.d.ts': 'export {}\n',
        'dist/identity.js': 'export {}\n',
        'dist/identity.d.ts': 'export {}\n',
      },
    );

    const result = await checkPackageExportArtifacts({ root });
    assert.equal(result.ok, true, result.messages.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when an exported declaration artifact is missing', async () => {
  const root = makeRepo();
  try {
    writePackage(
      root,
      'packages/core',
      {
        name: '@dzupagent/core',
        types: 'dist/index.d.ts',
        exports: {
          './identity': {
            import: './dist/identity.js',
            types: './dist/identity.d.ts',
          },
        },
      },
      {
        'dist/index.d.ts': 'export {}\n',
        'dist/identity.js': 'export {}\n',
      },
    );

    const result = await checkPackageExportArtifacts({ root });
    assert.equal(result.ok, false);
    assert.match(result.messages.join('\n'), /@dzupagent\/core \.\/identity types target is missing: packages\/core\/dist\/identity\.d\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when an export omits a types condition', async () => {
  const root = makeRepo();
  try {
    writePackage(
      root,
      'packages/server',
      {
        name: '@dzupagent/server',
        exports: {
          '.': {
            import: './dist/index.js',
          },
        },
      },
      {
        'dist/index.js': 'export {}\n',
      },
    );

    const result = await checkPackageExportArtifacts({ root });
    assert.equal(result.ok, false);
    assert.match(result.messages.join('\n'), /@dzupagent\/server \. export has no types target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when exported declarations reference a missing internal declaration artifact', async () => {
  const root = makeRepo();
  try {
    writePackage(
      root,
      'packages/core',
      {
        name: '@dzupagent/core',
        types: 'dist/index.d.ts',
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
          },
        },
      },
      {
        'dist/index.js': 'export {}\n',
        'dist/index.d.ts': "export { MissingType } from './missing.js'\n",
      },
    );

    const result = await checkPackageExportArtifacts({ root });
    assert.equal(result.ok, false);
    assert.match(
      result.messages.join('\n'),
      /@dzupagent\/core packages\/core\/dist\/index\.d\.ts references missing declaration artifact via \.\/missing\.js; tried packages\/core\/dist\/missing\.d\.ts/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('passes when exported declarations reference internal declaration artifacts transitively', async () => {
  const root = makeRepo();
  try {
    writePackage(
      root,
      'packages/core',
      {
        name: '@dzupagent/core',
        types: 'dist/index.d.ts',
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
          },
        },
      },
      {
        'dist/index.js': 'export {}\n',
        'dist/index.d.ts': "export { PublicType } from './public.js'\n",
        'dist/public.d.ts': "import('./internal.js');\nexport interface PublicType { value: InternalType }\n",
        'dist/internal.d.ts': 'export interface InternalType { id: string }\n',
      },
    );

    const result = await checkPackageExportArtifacts({ root });
    assert.equal(result.ok, true, result.messages.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignores relative declaration specifiers inside comments', async () => {
  const root = makeRepo();
  try {
    writePackage(
      root,
      'packages/core',
      {
        name: '@dzupagent/core',
        types: 'dist/index.d.ts',
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
          },
        },
      },
      {
        'dist/index.js': 'export {}\n',
        'dist/index.d.ts': [
          '/**',
          " *   import type { Example } from './missing-example.js'",
          ' */',
          'export interface PublicType { value: string }',
          '',
        ].join('\n'),
      },
    );

    const result = await checkPackageExportArtifacts({ root });
    assert.equal(result.ok, true, result.messages.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('can check a focused package directory list', async () => {
  const root = makeRepo();
  try {
    writePackage(
      root,
      'packages/core',
      {
        name: '@dzupagent/core',
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
          },
        },
      },
      {
        'dist/index.js': 'export {}\n',
        'dist/index.d.ts': 'export {}\n',
      },
    );
    writePackage(
      root,
      'packages/server',
      {
        name: '@dzupagent/server',
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
          },
        },
      },
      {},
    );

    const result = await checkPackageExportArtifacts({ root, packageDirs: ['packages/core'] });
    assert.equal(result.ok, true, result.messages.join('\n'));
    assert.deepEqual(result.packageDirs, ['packages/core']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
