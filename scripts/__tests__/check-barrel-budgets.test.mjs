import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { evaluateBarrelBudgets } from '../check-barrel-budgets.mjs'

/**
 * DZUPAGENT-CODE-C-01: `check:barrel-budgets` had no unit test of its own
 * (unlike the other 13 structural gates), which is part of why 25 live
 * violations went unnoticed for an extended period. This suite exercises
 * `evaluateBarrelBudgets` directly against fixture package trees.
 */
function createFixtureRoot({ indexLines = 5, extraFiles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'barrel-budgets-'))
  const srcDir = join(root, 'packages', 'alpha', 'src')
  mkdirSync(srcDir, { recursive: true })

  const exportLine = "export { thing } from './thing.js'\n"
  writeFileSync(join(srcDir, 'index.ts'), exportLine.repeat(indexLines), 'utf8')

  for (const [relPath, lineCount] of Object.entries(extraFiles)) {
    const abs = join(srcDir, relPath)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, 'export const x = 1\n'.repeat(lineCount), 'utf8')
  }

  return root
}

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function debtPin(overrides = {}) {
  return {
    sourceCommit: 'a'.repeat(40),
    reviewBy: '2026-09-09',
    rationale: 'Retained compatibility debt is frozen pending tracked decomposition.',
    ...overrides,
  }
}

test('passes when every metric is within its pinned budget', () => {
  const root = createFixtureRoot({ indexLines: 5 })
  try {
    const result = evaluateBarrelBudgets({
      root,
      budgetConfig: {
        packages: {
          '@dzupagent/alpha': { maxRootIndexLines: 10, maxFileLines: 500 },
        },
      },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.messages, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when maxRootIndexLines is exceeded (growth-halt)', () => {
  const root = createFixtureRoot({ indexLines: 12 })
  try {
    const result = evaluateBarrelBudgets({
      root,
      budgetConfig: {
        packages: {
          '@dzupagent/alpha': { maxRootIndexLines: 10 },
        },
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /maxRootIndexLines exceeded \(measured 12, budget 10\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when a source file exceeds the per-file LOC ceiling', () => {
  const root = createFixtureRoot({
    indexLines: 3,
    extraFiles: { 'big-module.ts': 600 },
  })
  try {
    const result = evaluateBarrelBudgets({
      root,
      budgetConfig: {
        packages: {
          '@dzupagent/alpha': { maxFileLines: 500 },
        },
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /big-module\.ts: 600 LOC exceeds the 500-LOC per-file ceiling/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fileLineAllowlist is rejected outright — no uncapped per-file exemption exists (RF-03)', () => {
  const root = createFixtureRoot({
    indexLines: 3,
    extraFiles: { 'big-module.ts': 600 },
  })
  try {
    assert.throws(
      () => evaluateBarrelBudgets({
        root,
        budgetConfig: {
          packages: {
            '@dzupagent/alpha': { maxFileLines: 500, fileLineAllowlist: ['src/big-module.ts'] },
          },
        },
      }),
      /fileLineAllowlist has been removed/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an empty fileLineAllowlist is rejected too, so the key cannot creep back in', () => {
  const root = createFixtureRoot({ indexLines: 3 })
  try {
    assert.throws(
      () => evaluateBarrelBudgets({
        root,
        budgetConfig: {
          packages: {
            '@dzupagent/alpha': { maxFileLines: 500, fileLineAllowlist: [] },
          },
        },
      }),
      /fileLineAllowlist has been removed/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a debt-pinned file fails closed as soon as one line is appended (RF-03)', () => {
  const root = createFixtureRoot({
    indexLines: 3,
    extraFiles: { 'big-module.ts': 600 },
  })
  try {
    const target = join(root, 'packages', 'alpha', 'src', 'big-module.ts')
    const original = readFileSync(target, 'utf8')
    const budgetConfig = {
      packages: {
        '@dzupagent/alpha': {
          maxFileLines: 500,
          fileLineDebtPins: {
            'src/big-module.ts': {
              maxLines: 600,
              shrinkTarget: 500,
              sourceSha256: createHash('sha256').update(original).digest('hex'),
              sourceCommit: 'a'.repeat(40),
              reviewBy: '2999-01-01',
              rationale: 'Fixture pin standing in for pre-existing per-file debt under test.',
            },
          },
        },
      },
    }

    const before = evaluateBarrelBudgets({ root, budgetConfig })
    assert.equal(before.ok, true)
    assert.equal(before.debtPins.length, 1)

    writeFileSync(target, `${original}// one appended line\n`)
    const after = evaluateBarrelBudgets({ root, budgetConfig })
    assert.equal(after.ok, false)
    // Zero-slack pin: the appended line trips the line cap first; a same-length
    // edit would trip the content digest instead. Either way it fails closed.
    assert.match(
      after.messages.join('\n'),
      /maxLines exceeded its source-bound debt pin \(measured 601, pin 600\)/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an auxiliarySourceLineBudgets breach is reported by its own metric name', () => {
  const root = createFixtureRoot({
    indexLines: 3,
    extraFiles: { 'aux-module.ts': 50 },
  })
  try {
    const result = evaluateBarrelBudgets({
      root,
      budgetConfig: {
        packages: {
          '@dzupagent/alpha': {
            maxRootIndexLines: 10,
            auxiliarySourceLineBudgets: { 'src/aux-module.ts': 20 },
          },
        },
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /src\/aux-module\.ts maxLines exceeded \(measured 50, budget 20\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts root growth only through an exact source-bound finite debt pin', () => {
  const root = createFixtureRoot({ indexLines: 12 })
  try {
    const indexPath = join(root, 'packages', 'alpha', 'src', 'index.ts')
    const result = evaluateBarrelBudgets({
      root,
      now: new Date('2026-08-09T00:00:00Z'),
      budgetConfig: {
        packages: {
          '@dzupagent/alpha': {
            maxRootIndexLines: 10,
            rootDebtPin: debtPin({
              maxRootIndexLines: 12,
              sourceSha256: fileSha256(indexPath),
            }),
          },
        },
      },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.messages, [])
    assert.deepEqual(result.debtPins, [{
      kind: 'root-barrel',
      label: '@dzupagent/alpha',
      metric: 'maxRootIndexLines',
      measured: 12,
      target: 10,
      pinnedLimit: 12,
      reviewBy: '2026-09-09',
      sourceCommit: 'a'.repeat(40),
    }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails closed when a root debt pin is expired or its bytes drift', () => {
  const root = createFixtureRoot({ indexLines: 12 })
  try {
    const pin = debtPin({
      maxRootIndexLines: 12,
      sourceSha256: 'b'.repeat(64),
      reviewBy: '2026-08-08',
    })
    const result = evaluateBarrelBudgets({
      root,
      now: new Date('2026-08-09T00:00:00Z'),
      budgetConfig: {
        packages: { '@dzupagent/alpha': { maxRootIndexLines: 10, rootDebtPin: pin } },
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /source-bound debt pin hash mismatch/)

    pin.sourceSha256 = fileSha256(join(root, 'packages', 'alpha', 'src', 'index.ts'))
    const expired = evaluateBarrelBudgets({
      root,
      now: new Date('2026-08-09T00:00:00Z'),
      budgetConfig: {
        packages: { '@dzupagent/alpha': { maxRootIndexLines: 10, rootDebtPin: pin } },
      },
    })
    assert.equal(expired.ok, false)
    assert.match(expired.messages.join('\n'), /source-bound debt pin expired on 2026-08-08/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('freezes an oversized file at an exact line count and content digest', () => {
  const root = createFixtureRoot({ indexLines: 3, extraFiles: { 'big-module.ts': 600 } })
  try {
    const bigModule = join(root, 'packages', 'alpha', 'src', 'big-module.ts')
    const budgetConfig = {
      packages: {
        '@dzupagent/alpha': {
          maxFileLines: 500,
          fileLineDebtPins: {
            'src/big-module.ts': debtPin({
              maxLines: 600,
              sourceSha256: fileSha256(bigModule),
            }),
          },
        },
      },
    }
    const accepted = evaluateBarrelBudgets({
      root, budgetConfig, now: new Date('2026-08-09T00:00:00Z'),
    })
    assert.equal(accepted.ok, true)
    assert.equal(accepted.debtPins.length, 1)

    writeFileSync(bigModule, 'export const x = 1\n'.repeat(601), 'utf8')
    const drifted = evaluateBarrelBudgets({
      root, budgetConfig, now: new Date('2026-08-09T00:00:00Z'),
    })
    assert.equal(drifted.ok, false)
    assert.match(drifted.messages.join('\n'), /exceeded its source-bound debt pin/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
