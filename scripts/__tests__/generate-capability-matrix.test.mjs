import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { generateCapabilityMatrix } from '../generate-capability-matrix.mjs'

/**
 * The matrix indexed root barrels only, so any symbol published on a subpath was
 * invisible to it. That is structural rather than cosmetic: the barrel ratchet
 * deliberately pushes API onto subpaths, so every relocation made the workspace's
 * API inventory less accurate. Relocating the pricing cluster to
 * `@dzupagent/core/middleware` dropped eleven still-public symbols out of it.
 *
 * These fixtures pin the subpath indexing, the dedup that keeps a mid-flight
 * relocation from double-counting, and the skip for export entries that have no
 * source module.
 */
function createFixtureRoot(pkg) {
  const root = mkdtempSync(join(tmpdir(), 'capability-matrix-'))
  const pkgDir = join(root, 'packages', 'alpha')
  const srcDir = join(pkgDir, 'src')
  mkdirSync(srcDir, { recursive: true })

  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg.packageJson), 'utf8')
  for (const [relPath, contents] of Object.entries(pkg.sources)) {
    const abs = join(srcDir, relPath)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, contents, 'utf8')
  }

  return root
}

function readMatrix(root) {
  return readFileSync(join(root, 'docs', 'CAPABILITY_MATRIX.md'), 'utf8')
}

test('indexes symbols published only on a subpath', () => {
  const root = createFixtureRoot({
    packageJson: {
      name: '@dzupagent/alpha',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './middleware': { types: './dist/middleware.d.ts', import: './dist/middleware.js' },
      },
    },
    sources: {
      'index.ts': 'export function rootOnly() {}\n',
      'middleware.ts': 'export function buildModelTariff() {}\n',
    },
  })

  try {
    generateCapabilityMatrix(root)
    const matrix = readMatrix(root)
    // The regression case: reachable from the package, absent from the root barrel.
    assert.match(matrix, /buildModelTariff/)
    assert.match(matrix, /rootOnly/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('counts a symbol once when a root and a subpath both export it', () => {
  // A relocation is briefly exported from both places. Counting it twice would
  // report growth that never happened and mask the later root deletion.
  const root = createFixtureRoot({
    packageJson: {
      name: '@dzupagent/alpha',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './middleware': { types: './dist/middleware.d.ts', import: './dist/middleware.js' },
      },
    },
    sources: {
      'index.ts': "export { sharedSymbol } from './middleware.js'\n",
      'middleware.ts': 'export function sharedSymbol() {}\n',
    },
  })

  try {
    generateCapabilityMatrix(root)
    // Scope to the detail section: the summary table repeats key exports by
    // design, so a whole-file count would conflate rendering with inventory.
    const detail = readMatrix(root).split('## Detailed Exports')[1] ?? ''
    const occurrences = detail.match(/sharedSymbol/g) ?? []
    assert.equal(occurrences.length, 1, 'symbol on both a root and a subpath must be listed once')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skips export entries that resolve to no source module', () => {
  // runtime-contracts publishes JSON fixtures whose `.d.ts` is a hand-written
  // ambient declaration beside the data file. They carry no API symbols; treating
  // one as an empty barrel would drop the package's real exports.
  const root = createFixtureRoot({
    packageJson: {
      name: '@dzupagent/alpha',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './fixtures/conformance-v1.json': {
          types: './fixtures/conformance-v1.d.ts',
          default: './fixtures/conformance-v1.json',
        },
      },
    },
    sources: { 'index.ts': 'export function realSymbol() {}\n' },
  })

  try {
    generateCapabilityMatrix(root)
    assert.match(readMatrix(root), /realSymbol/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('falls back to the root barrel when a package declares no exports map', () => {
  const root = createFixtureRoot({
    packageJson: { name: '@dzupagent/alpha' },
    sources: { 'index.ts': 'export function legacySymbol() {}\n' },
  })

  try {
    generateCapabilityMatrix(root)
    assert.match(readMatrix(root), /legacySymbol/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
