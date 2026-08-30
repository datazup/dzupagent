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
  isNonSourceBuildInput,
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

test('tool scratch dropped inside src does not shift recorded build-input identity', async () => {
  await withRepo(async (root) => {
    const clean = await captureBuildInputSnapshot({ root, packageDir: 'packages/core' })

    // The exact shape observed in the canonical tree on 2026-08-30: 132 stale
    // Codex CLI logs sitting beside source across three packages, 52 of them in
    // core, which moved core's recorded input count 511 -> 563 while every
    // emitted byte stayed identical.
    writeText(root, 'packages/core/src/config/ARCHITECTURE.md.stdout.log', '')
    writeText(root, 'packages/core/src/config/ARCHITECTURE.md.stderr.log', 'OpenAI Codex v0.137.0\n')
    writeText(root, 'packages/core/src/index.ts.orig', 'export const value = 99\n')
    writeText(root, 'packages/core/src/.DS_Store', '\0\0')

    const contaminated = await captureBuildInputSnapshot({ root, packageDir: 'packages/core' })

    assert.equal(
      contaminated.inputFileCount,
      clean.inputFileCount,
      'scratch files must not be counted as build inputs',
    )
    assert.equal(
      contaminated.inputFingerprint,
      clean.inputFingerprint,
      'build-input identity must reproduce across checkouts of the same commit',
    )
  })
})

test('a real source file still shifts recorded build-input identity', async () => {
  await withRepo(async (root) => {
    const before = await captureBuildInputSnapshot({ root, packageDir: 'packages/core' })
    writeText(root, 'packages/core/src/added.ts', 'export const added = 1\n')
    const after = await captureBuildInputSnapshot({ root, packageDir: 'packages/core' })

    assert.equal(
      after.inputFileCount,
      before.inputFileCount + 1,
      'genuine source additions must still be measured',
    )
    assert.notEqual(
      after.inputFingerprint,
      before.inputFingerprint,
      'genuine source additions must still change the fingerprint',
    )
  })
})

test('the non-source denylist matches scratch and never matches real source', async () => {
  for (const scratch of [
    'packages/core/src/config/ARCHITECTURE.md.stdout.log',
    'packages/core/src/config/ARCHITECTURE.md.stderr.log',
    'packages/core/src/index.ts.orig',
    'packages/core/src/index.ts.rej',
    'packages/core/src/index.ts.bak',
    'packages/core/src/.index.ts.swp',
    'packages/core/src/index.ts~',
    'packages/core/src/build.tmp',
    'packages/core/src/.DS_Store',
    'packages/core/src/Thumbs.db',
  ]) {
    assert.equal(isNonSourceBuildInput(scratch), true, `must exclude ${scratch}`)
  }

  for (const source of [
    'packages/core/src/index.ts',
    'packages/core/src/index.tsx',
    'packages/core/src/index.d.ts',
    'packages/core/src/fixtures/schema.json',
    'packages/core/src/prompts/system.txt',
    'packages/core/src/styles.css',
    'packages/core/src/queries/find.sql',
    'packages/core/src/catalog.md',
    'packages/core/src/logger.ts',
    'packages/core/src/logging/index.ts',
  ]) {
    assert.equal(isNonSourceBuildInput(source), false, `must keep ${source}`)
  }
})
