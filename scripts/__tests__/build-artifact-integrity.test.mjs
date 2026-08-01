import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  BUILD_ARTIFACT_MANIFEST,
  captureBuildInputSnapshot,
  verifyBuildArtifactManifest,
  writeBuildArtifactManifest,
} from '../build-artifact-integrity.mjs'
import { checkBuildArtifactIntegrity } from '../check-build-artifact-integrity.mjs'

function writeText(root, relativePath, content) {
  const filePath = path.join(root, relativePath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
}

function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'dzup-build-artifacts-'))
  writeText(root, 'package.json', '{"name":"fixture-root"}\n')
  writeText(root, 'turbo.json', '{"tasks":{}}\n')
  writeText(root, 'tsconfig.json', '{"compilerOptions":{}}\n')
  writeText(root, 'yarn.lock', '# fixture\n')
  writeText(root, '.yarnrc.yml', 'nodeLinker: pnp\n')
  writeText(root, 'scripts/build-artifact-integrity.mjs', 'export {}\n')
  writeText(root, 'scripts/check-package-export-artifacts.mjs', 'export {}\n')
  writeText(root, 'scripts/prepare-build-artifact-manifest.mjs', 'export {}\n')
  writeText(root, 'scripts/write-build-artifact-manifest.mjs', 'export {}\n')
  writeText(
    root,
    'packages/core/package.json',
    JSON.stringify({
      name: '@dzupagent/core',
      scripts: { build: 'fixture' },
      types: './dist/index.d.ts',
      exports: {
        '.': {
          import: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
    }),
  )
  writeText(root, 'packages/core/tsconfig.json', '{"compilerOptions":{}}\n')
  writeText(root, 'packages/core/src/index.ts', 'export const value = 1\n')
  writeText(root, 'packages/core/dist/index.js', 'export const value = 1\n')
  writeText(root, 'packages/core/dist/index.d.ts', 'export declare const value = 1\n')
  return root
}

async function withRepo(callback) {
  const root = makeRepo()
  try {
    await callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('writes a deterministic path-safe completion manifest and verifies it', async () => {
  await withRepo(async (root) => {
    const first = await writeBuildArtifactManifest({
      root,
      packageDir: 'packages/core',
    })
    const manifestText = readFileSync(
      path.join(root, 'packages/core/dist', BUILD_ARTIFACT_MANIFEST),
      'utf8',
    )
    assert.equal(manifestText.includes(root), false)
    assert.deepEqual(first.artifacts.map((artifact) => artifact.path), [
      'index.d.ts',
      'index.js',
    ])

    const result = await verifyBuildArtifactManifest({
      root,
      packageDir: 'packages/core',
    })
    assert.equal(result.ok, true, result.messages.join('\n'))
  })
})

test('rejects a partial dist tree when one declaration was not restored', async () => {
  await withRepo(async (root) => {
    await writeBuildArtifactManifest({ root, packageDir: 'packages/core' })
    rmSync(path.join(root, 'packages/core/dist/index.d.ts'))

    const result = await verifyBuildArtifactManifest({
      root,
      packageDir: 'packages/core',
    })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /artifact is missing: dist\/index\.d\.ts/)
  })
})

test('rejects a modified runtime artifact even when its filename remains', async () => {
  await withRepo(async (root) => {
    await writeBuildArtifactManifest({ root, packageDir: 'packages/core' })
    writeText(root, 'packages/core/dist/index.js', 'export const value = 2\n')

    const result = await verifyBuildArtifactManifest({
      root,
      packageDir: 'packages/core',
    })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /artifact changed after build: dist\/index\.js/)
  })
})

test('rejects stale dist output after a package source change', async () => {
  await withRepo(async (root) => {
    await writeBuildArtifactManifest({ root, packageDir: 'packages/core' })
    writeText(root, 'packages/core/src/index.ts', 'export const value = 3\n')

    const result = await verifyBuildArtifactManifest({
      root,
      packageDir: 'packages/core',
    })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /dist was built from stale package inputs/)
  })
})

test('rejects source drift that occurs while a package build is running', async () => {
  await withRepo(async (root) => {
    const expectedInputs = await captureBuildInputSnapshot({
      root,
      packageDir: 'packages/core',
    })
    writeText(root, 'packages/core/src/index.ts', 'export const value = 4\n')

    await assert.rejects(
      writeBuildArtifactManifest({
        root,
        packageDir: 'packages/core',
        expectedInputs,
      }),
      /source inputs changed during build/,
    )
  })
})

test('rejects unmanifested files left in dist after a build', async () => {
  await withRepo(async (root) => {
    await writeBuildArtifactManifest({ root, packageDir: 'packages/core' })
    writeText(root, 'packages/core/dist/stale.js', 'export {}\n')

    const result = await verifyBuildArtifactManifest({
      root,
      packageDir: 'packages/core',
    })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /unmanifested artifact: dist\/stale\.js/)
  })
})

test('combines manifest integrity with public export and declaration closure checks', async () => {
  await withRepo(async (root) => {
    await writeBuildArtifactManifest({ root, packageDir: 'packages/core' })
    const valid = await checkBuildArtifactIntegrity({
      root,
      packageDirs: ['packages/core'],
    })
    assert.equal(valid.ok, true, valid.messages.join('\n'))

    rmSync(path.join(root, 'packages/core/dist/index.d.ts'))
    const partial = await checkBuildArtifactIntegrity({
      root,
      packageDirs: ['packages/core'],
    })
    assert.equal(partial.ok, false)
    assert.match(partial.messages.join('\n'), /types target is missing/)
  })
})
