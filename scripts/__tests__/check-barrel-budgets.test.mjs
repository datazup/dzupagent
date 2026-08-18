import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  ACCEPTED_GROWTH_MAX_AGE_DAYS,
  evaluateBarrelBudgets,
  evaluateBudgetRatchet,
} from '../check-barrel-budgets.mjs'

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
      // Derived from the enforced budget, never declared: see the shrink-target
      // tests below.
      shrinkTarget: 10,
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

/**
 * RF-03 follow-up: the shrink target must be the budget the gate already
 * enforces. `shrinkTarget` used to appear exactly once in the whole tree — inside
 * an error-message template literal — so a pin could declare any aspiration it
 * liked and nothing compared it to anything.
 */
test('a declared shrinkTarget that disagrees with the enforced budget fails closed', () => {
  const root = createFixtureRoot({ indexLines: 12 })
  try {
    const result = evaluateBarrelBudgets({
      root,
      now: new Date('2026-08-09T00:00:00Z'),
      budgetConfig: {
        packages: {
          '@dzupagent/alpha': {
            maxRootIndexLines: 10,
            rootDebtPin: debtPin({
              maxRootIndexLines: 12,
              // Softer than the 10 the gate enforces — the exact drift the
              // derived target exists to prevent.
              shrinkTargets: { maxRootIndexLines: 11 },
              sourceSha256: fileSha256(join(root, 'packages', 'alpha', 'src', 'index.ts')),
            }),
          },
        },
      },
    })
    assert.equal(result.ok, false)
    assert.match(
      result.messages.join('\n'),
      /declares a shrink target of 11 for maxRootIndexLines but the enforced budget is 10/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a declared shrinkTarget that agrees with the budget is accepted', () => {
  const root = createFixtureRoot({ indexLines: 3, extraFiles: { 'big-module.ts': 600 } })
  try {
    const result = evaluateBarrelBudgets({
      root,
      now: new Date('2026-08-09T00:00:00Z'),
      budgetConfig: {
        packages: {
          '@dzupagent/alpha': {
            maxFileLines: 500,
            fileLineDebtPins: {
              'src/big-module.ts': debtPin({
                maxLines: 600,
                shrinkTarget: 500,
                sourceSha256: fileSha256(join(root, 'packages', 'alpha', 'src', 'big-module.ts')),
              }),
            },
          },
        },
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.debtPins[0].shrinkTarget, 500)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The ratchet. RF-03 made the debt visible but nothing stopped a pin being
 * re-pinned upward, so between 2026-08-04 and 2026-08-18 the checked-in numbers
 * moved UP 16 times against ONE decrease — including two commits made by the
 * session that shipped the gate. These tests are the mechanism that would have
 * blocked them.
 */
const NOW = new Date('2026-08-18T12:00:00Z')

function ratchetConfig(agentPin, extra = {}) {
  return {
    packages: {
      '@dzupagent/alpha': {
        maxRootIndexLines: 10,
        rootDebtPin: { maxRootIndexLines: agentPin },
      },
    },
    ...extra,
  }
}

function growthRecord(overrides = {}) {
  return {
    key: '@dzupagent/alpha/rootDebtPin/maxRootIndexLines',
    from: 12,
    to: 14,
    reason: 'Accepted because the subpath migration is scheduled for the next minor release.',
    approvedBy: 'esmirisic',
    date: '2026-08-18',
    ...overrides,
  }
}

test('ratchet rejects a re-pin that moves away from its shrink target', () => {
  const result = evaluateBudgetRatchet({
    budgetConfig: ratchetConfig(14),
    baseBudgetConfig: ratchetConfig(12),
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.growth, [{
    key: '@dzupagent/alpha/rootDebtPin/maxRootIndexLines',
    from: 12,
    to: 14,
  }])
  assert.match(result.messages.join('\n'), /moved AWAY from its shrink target \(12 -> 14\)/)
  // The failure message must be copy-pasteable into the budget file.
  assert.match(result.messages.join('\n'), /"from": 12, "to": 14/)
})

test('ratchet allows a number to move DOWN, and a satisfied pin to be deleted', () => {
  const shrunk = evaluateBudgetRatchet({
    budgetConfig: ratchetConfig(12),
    baseBudgetConfig: ratchetConfig(14),
    now: NOW,
  })
  assert.equal(shrunk.ok, true)
  assert.deepEqual(shrunk.growth, [])

  const deleted = evaluateBudgetRatchet({
    budgetConfig: { packages: { '@dzupagent/alpha': { maxRootIndexLines: 10 } } },
    baseBudgetConfig: ratchetConfig(14),
    now: NOW,
  })
  assert.equal(deleted.ok, true)
  assert.deepEqual(deleted.growth, [])
})

test('ratchet also covers the budget caps themselves, not only the pins', () => {
  // "Accept" means raising the budget to the measured value and deleting the
  // pin. That is the loudest possible growth and must be signed too.
  const result = evaluateBudgetRatchet({
    budgetConfig: { packages: { '@dzupagent/alpha': { maxRootIndexLines: 14 } } },
    baseBudgetConfig: { packages: { '@dzupagent/alpha': { maxRootIndexLines: 10 } } },
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.match(
    result.messages.join('\n'),
    /@dzupagent\/alpha\/maxRootIndexLines: moved AWAY from its shrink target \(10 -> 14\)/,
  )
})

test('ratchet accepts growth carrying an exact, current signature', () => {
  const result = evaluateBudgetRatchet({
    budgetConfig: ratchetConfig(14, { acceptedGrowth: [growthRecord()] }),
    baseBudgetConfig: ratchetConfig(12),
    now: NOW,
  })
  assert.equal(result.ok, true)
  assert.equal(result.accepted.length, 1)
  assert.equal(result.accepted[0].approvedBy, 'esmirisic')
  assert.deepEqual(result.unusedRecords, [])
})

test('a signature is bound to one exact transition, so it cannot cover a later raise', () => {
  const result = evaluateBudgetRatchet({
    // Signed 12 -> 14; the file actually says 15.
    budgetConfig: ratchetConfig(15, { acceptedGrowth: [growthRecord()] }),
    baseBudgetConfig: ratchetConfig(12),
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.match(result.messages.join('\n'), /\(12 -> 15\) with no acceptedGrowth signature/)
  assert.equal(result.unusedRecords.length, 1)
})

test('one signature cannot authorise two separate raises', () => {
  const base = {
    packages: {
      '@dzupagent/alpha': { maxRootIndexLines: 12, rootDebtPin: { maxRootIndexLines: 12 } },
    },
  }
  const grown = {
    packages: {
      '@dzupagent/alpha': { maxRootIndexLines: 14, rootDebtPin: { maxRootIndexLines: 14 } },
    },
    acceptedGrowth: [growthRecord({ key: '@dzupagent/alpha/maxRootIndexLines' })],
  }
  const result = evaluateBudgetRatchet({ budgetConfig: grown, baseBudgetConfig: base, now: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.accepted.length, 1)
  assert.match(
    result.messages.join('\n'),
    /rootDebtPin\/maxRootIndexLines: moved AWAY .* with no acceptedGrowth signature/,
  )
})

test('a signature expires, so an old one cannot silently re-authorise the same growth', () => {
  const stale = new Date(NOW.getTime() + (ACCEPTED_GROWTH_MAX_AGE_DAYS + 2) * 86_400_000)
  const result = evaluateBudgetRatchet({
    budgetConfig: ratchetConfig(14, { acceptedGrowth: [growthRecord()] }),
    baseBudgetConfig: ratchetConfig(12),
    now: stale,
  })
  assert.equal(result.ok, false)
  assert.match(result.messages.join('\n'), /signature is 32 days old, past the 30-day limit/)
})

test('a signature cannot be pre-dated into the future', () => {
  const result = evaluateBudgetRatchet({
    budgetConfig: ratchetConfig(14, { acceptedGrowth: [growthRecord({ date: '2026-09-01' })] }),
    baseBudgetConfig: ratchetConfig(12),
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.match(result.messages.join('\n'), /dated in the future \(2026-09-01\)/)
})

test('a signature needs a real reason and a named signer', () => {
  const thin = evaluateBudgetRatchet({
    budgetConfig: ratchetConfig(14, { acceptedGrowth: [growthRecord({ reason: 'ok' })] }),
    baseBudgetConfig: ratchetConfig(12),
    now: NOW,
  })
  assert.equal(thin.ok, false)
  assert.match(thin.messages.join('\n'), /reason must explain why the growth is accepted/)

  const anonymous = evaluateBudgetRatchet({
    budgetConfig: ratchetConfig(14, { acceptedGrowth: [growthRecord({ approvedBy: '  ' })] }),
    baseBudgetConfig: ratchetConfig(12),
    now: NOW,
  })
  assert.equal(anonymous.ok, false)
  assert.match(anonymous.messages.join('\n'), /approvedBy must name the person or role/)
})

test('when acceptedGrowthApprovers is configured, only a listed signer may accept growth', () => {
  const budgetConfig = ratchetConfig(14, {
    acceptedGrowth: [growthRecord({ approvedBy: 'some-session' })],
    acceptedGrowthApprovers: ['esmirisic'],
  })
  const rejected = evaluateBudgetRatchet({
    budgetConfig,
    baseBudgetConfig: ratchetConfig(12),
    now: NOW,
  })
  assert.equal(rejected.ok, false)
  assert.match(rejected.messages.join('\n'), /"some-session" is not in acceptedGrowthApprovers/)
  assert.equal(rejected.approversConfigured, true)

  budgetConfig.acceptedGrowth = [growthRecord({ approvedBy: 'esmirisic' })]
  const allowed = evaluateBudgetRatchet({
    budgetConfig,
    baseBudgetConfig: ratchetConfig(12),
    now: NOW,
  })
  assert.equal(allowed.ok, true)
})

test('a malformed acceptedGrowth block is a hard error, not a soft pass', () => {
  assert.throws(
    () => evaluateBudgetRatchet({
      budgetConfig: ratchetConfig(14, { acceptedGrowth: { key: 'x' } }),
      baseBudgetConfig: ratchetConfig(12),
      now: NOW,
    }),
    /acceptedGrowth must be an array/,
  )
  assert.throws(
    () => evaluateBudgetRatchet({
      budgetConfig: ratchetConfig(12, { acceptedGrowthApprovers: 'esmirisic' }),
      baseBudgetConfig: ratchetConfig(12),
      now: NOW,
    }),
    /acceptedGrowthApprovers must be an array of non-empty strings/,
  )
})

test('ratchet reaches every numeric knob, including nested per-file pins', () => {
  const base = {
    packages: {
      '@dzupagent/alpha': {
        maxFileLines: 500,
        fileLineDebtPins: { 'src/big-module.ts': { maxLines: 600, shrinkTarget: 500 } },
        auxiliarySourceLineBudgets: { 'src/aux.ts': 20 },
      },
    },
  }
  const grown = JSON.parse(JSON.stringify(base))
  grown.packages['@dzupagent/alpha'].fileLineDebtPins['src/big-module.ts'].maxLines = 640
  grown.packages['@dzupagent/alpha'].auxiliarySourceLineBudgets['src/aux.ts'] = 25
  // Moving the goalpost itself is the sneakiest escape of the three.
  grown.packages['@dzupagent/alpha'].fileLineDebtPins['src/big-module.ts'].shrinkTarget = 550

  const result = evaluateBudgetRatchet({ budgetConfig: grown, baseBudgetConfig: base, now: NOW })
  assert.equal(result.ok, false)
  assert.deepEqual(result.growth.map((move) => move.key).sort(), [
    '@dzupagent/alpha/auxiliarySourceLineBudgets/src/aux.ts',
    '@dzupagent/alpha/fileLineDebtPins/src/big-module.ts/maxLines',
    '@dzupagent/alpha/fileLineDebtPins/src/big-module.ts/shrinkTarget',
  ])
})

test('a brand-new package or pin is not ratcheted growth (there is no base number)', () => {
  const result = evaluateBudgetRatchet({
    budgetConfig: {
      packages: {
        '@dzupagent/alpha': { maxRootIndexLines: 10 },
        '@dzupagent/beta': { maxRootIndexLines: 900 },
      },
    },
    baseBudgetConfig: { packages: { '@dzupagent/alpha': { maxRootIndexLines: 10 } } },
    now: NOW,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.growth, [])
})
