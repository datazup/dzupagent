import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ACCEPTED_GROWTH_MAX_AGE_DAYS,
  evaluateBarrelBudgets,
  evaluateBudgetRatchet,
  resolveRatchetBase,
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

// --- Deadline and rename ratchet (DZUPAGENT-ARCH-H-10) --------------------------
//
// The ratchet walked numeric leaves only, so a pin's reviewBy (the date that makes
// it fail closed) could be pushed out indefinitely without a signature, and a pin
// renamed within its package escaped as "deleted + brand-new".

function deadlineConfig(reviewBy, extra = {}) {
  return {
    packages: {
      '@dzupagent/alpha': {
        maxRootIndexLines: 10,
        rootDebtPin: { maxRootIndexLines: 12, reviewBy, rationale: 'kept', sourceSha256: 'f'.repeat(64) },
      },
    },
    ...extra,
  }
}

test('a reviewBy moved LATER without an acceptedGrowth record fails the ratchet', () => {
  const result = evaluateBudgetRatchet({
    budgetConfig: deadlineConfig('2026-11-30'),
    baseBudgetConfig: deadlineConfig('2026-09-30'),
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.growth, [{
    key: '@dzupagent/alpha/rootDebtPin/reviewBy',
    from: '2026-09-30',
    to: '2026-11-30',
  }])
  const text = result.messages.join('\n')
  assert.match(text, /review deadline moved LATER \(2026-09-30 -> 2026-11-30\)/)
  // Copy-pasteable record with JSON string values.
  assert.match(text, /"from": "2026-09-30", "to": "2026-11-30"/)
})

test('a reviewBy moved EARLIER (or unchanged) needs no signature', () => {
  for (const reviewBy of ['2026-09-30', '2026-09-01']) {
    const result = evaluateBudgetRatchet({
      budgetConfig: deadlineConfig(reviewBy),
      baseBudgetConfig: deadlineConfig('2026-09-30'),
      now: NOW,
    })
    assert.equal(result.ok, true, reviewBy)
    assert.deepEqual(result.growth, [])
  }
})

test('a reviewBy extension passes with an exact, current acceptedGrowth record', () => {
  const record = growthRecord({
    key: '@dzupagent/alpha/rootDebtPin/reviewBy',
    from: '2026-09-30',
    to: '2026-11-30',
  })
  const result = evaluateBudgetRatchet({
    budgetConfig: deadlineConfig('2026-11-30', { acceptedGrowth: [record] }),
    baseBudgetConfig: deadlineConfig('2026-09-30'),
    now: NOW,
  })
  assert.equal(result.ok, true, result.messages.join('\n'))
  assert.equal(result.accepted.length, 1)

  const wrongTarget = evaluateBudgetRatchet({
    budgetConfig: deadlineConfig('2026-12-31', { acceptedGrowth: [record] }),
    baseBudgetConfig: deadlineConfig('2026-09-30'),
    now: NOW,
  })
  assert.equal(wrongTarget.ok, false)
})

test('nested per-file pin reviewBy dates are ratcheted, other strings are not', () => {
  const base = {
    packages: {
      '@dzupagent/alpha': {
        maxFileLines: 500,
        fileLineDebtPins: {
          'src/big.ts': { maxLines: 600, reviewBy: '2026-09-01', sourceSha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40) },
        },
      },
    },
  }
  const grown = JSON.parse(JSON.stringify(base))
  const pin = grown.packages['@dzupagent/alpha'].fileLineDebtPins['src/big.ts']
  pin.reviewBy = '2026-10-01'
  pin.sourceSha256 = 'c'.repeat(64)
  pin.sourceCommit = 'd'.repeat(40)
  const result = evaluateBudgetRatchet({ budgetConfig: grown, baseBudgetConfig: base, now: NOW })
  assert.deepEqual(result.growth.map((move) => move.key), [
    '@dzupagent/alpha/fileLineDebtPins/src/big.ts/reviewBy',
  ])
})

function renameConfig(pins) {
  return { packages: { '@dzupagent/alpha': { maxFileLines: 500, fileLineDebtPins: pins } } }
}

test('a renamed pin with a higher maxLines fails the ratchet', () => {
  const result = evaluateBudgetRatchet({
    budgetConfig: renameConfig({ 'src/renamed.ts': { maxLines: 640, shrinkTarget: 500, reviewBy: '2026-09-01' } }),
    baseBudgetConfig: renameConfig({ 'src/original.ts': { maxLines: 600, shrinkTarget: 500, reviewBy: '2026-09-01' } }),
    now: NOW,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.growth, [{
    key: '@dzupagent/alpha/fileLineDebtPins/src/renamed.ts/maxLines',
    from: 600,
    to: 640,
    renamedFrom: '@dzupagent/alpha/fileLineDebtPins/src/original.ts',
  }])
  assert.match(result.messages.join('\n'), /renamed\.ts\/maxLines \(renamed from .*original\.ts\): moved AWAY \(?/)
})

test('a renamed pin is paired by digest first, and a later reviewBy on it fails too', () => {
  const result = evaluateBudgetRatchet({
    budgetConfig: renameConfig({
      'src/a-moved.ts': { maxLines: 700, reviewBy: '2026-12-01', sourceSha256: '1'.repeat(64) },
      'src/z-moved.ts': { maxLines: 550, reviewBy: '2026-09-01', sourceSha256: '2'.repeat(64) },
    }),
    baseBudgetConfig: renameConfig({
      'src/a.ts': { maxLines: 550, reviewBy: '2026-09-01', sourceSha256: '2'.repeat(64) },
      'src/z.ts': { maxLines: 700, reviewBy: '2026-09-01', sourceSha256: '1'.repeat(64) },
    }),
    now: NOW,
  })
  // Digest pairing maps a-moved <- z (700 -> 700) and z-moved <- a (550 -> 550):
  // only the deadline extension on a-moved is growth.
  assert.deepEqual(result.growth, [{
    key: '@dzupagent/alpha/fileLineDebtPins/src/a-moved.ts/reviewBy',
    from: '2026-09-01',
    to: '2026-12-01',
    renamedFrom: '@dzupagent/alpha/fileLineDebtPins/src/z.ts',
  }])
})

test('a renamed pin that keeps or lowers its numbers and deadline needs no signature', () => {
  const result = evaluateBudgetRatchet({
    budgetConfig: renameConfig({ 'src/lib/original.ts': { maxLines: 590, shrinkTarget: 500, reviewBy: '2026-09-01' } }),
    baseBudgetConfig: renameConfig({ 'src/original.ts': { maxLines: 600, shrinkTarget: 500, reviewBy: '2026-09-01' } }),
    now: NOW,
  })
  assert.equal(result.ok, true, result.messages.join('\n'))
  assert.deepEqual(result.growth, [])
})

test('a retired pin is never paired with an unrelated new pin by sorted position', () => {
  // DZUPAGENT-CODE-M-14: retiring src/codex/adapter.ts while unrelated pins are
  // added elsewhere (or several in its own directory) is a deletion, not a rename.
  const result = evaluateBudgetRatchet({
    budgetConfig: renameConfig({
      'src/approval/approval.ts': { maxLines: 900, shrinkTarget: 500, reviewBy: '2026-12-01' },
      'src/codex/app-server.ts': { maxLines: 800, shrinkTarget: 500, reviewBy: '2026-12-01' },
      'src/codex/client.ts': { maxLines: 700, shrinkTarget: 500, reviewBy: '2026-12-01' },
    }),
    baseBudgetConfig: renameConfig({
      'src/codex/adapter.ts': { maxLines: 600, shrinkTarget: 500, reviewBy: '2026-09-01' },
    }),
    now: NOW,
  })
  assert.equal(result.ok, true, result.messages.join('\n'))
  assert.deepEqual(result.growth, [])
})

test('a retired pin whose file still exists is not a rename, even alone in its directory', () => {
  const budgetConfig = renameConfig({
    'src/run/standard.ts': { maxLines: 800, shrinkTarget: 500, reviewBy: '2026-12-01' },
  })
  const baseBudgetConfig = renameConfig({
    'src/run/dispatch.ts': { maxLines: 600, shrinkTarget: 500, reviewBy: '2026-09-01' },
  })
  // Without a file probe the lone pair in src/run/ is read as a move.
  assert.equal(evaluateBudgetRatchet({ budgetConfig, baseBudgetConfig, now: NOW }).ok, false)
  // dispatch.ts shrank under the ceiling and its pin was retired: no rename.
  const result = evaluateBudgetRatchet({
    budgetConfig,
    baseBudgetConfig,
    now: NOW,
    pinFileExists: (packageName, pinKey) => packageName === '@dzupagent/alpha' && pinKey === 'src/run/dispatch.ts',
  })
  assert.equal(result.ok, true, result.messages.join('\n'))
  assert.deepEqual(result.growth, [])
})

// --- Ratchet base selection (DZUPAGENT-ARCH-C-04) -----------------------------
//
// The ratchet used to compare against HEAD. Once a raise is committed HEAD's copy
// of the budget file equals the working copy, so CI and every post-commit run saw
// zero growth. These tests drive the real CLI through a fixture repository.

const BARREL_SCRIPT = fileURLToPath(new URL('../check-barrel-budgets.mjs', import.meta.url))

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

function commitAll(root, message) {
  git(root, 'add', '-A')
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-q', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

function writeBudget(root, budget) {
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'barrel-budgets.json'), `${JSON.stringify(budget, null, 2)}\n`, 'utf8')
}

/** Two commits on main: the second raises a budget number and commits the raise. */
function createRaisedRepo({ acceptedGrowth } = {}) {
  const root = createFixtureRoot({ indexLines: 5 })
  git(root, 'init', '-q', '-b', 'main')
  writeBudget(root, { packages: { '@dzupagent/alpha': { maxRootIndexLines: 10 } } })
  const baseCommit = commitAll(root, 'budget')
  writeBudget(root, {
    ...(acceptedGrowth ? { acceptedGrowth } : {}),
    packages: { '@dzupagent/alpha': { maxRootIndexLines: 12 } },
  })
  const headCommit = commitAll(root, 'raise the budget')
  return { root, baseCommit, headCommit }
}

function runGate(root, { env = {}, args = [] } = {}) {
  const childEnv = { ...process.env, ...env }
  delete childEnv.BARREL_BUDGET_BASE_REF
  if (!('CI' in env)) delete childEnv.CI
  return spawnSync(process.execPath, [BARREL_SCRIPT, ...args], { cwd: root, env: childEnv, encoding: 'utf8' })
}

test('a committed raise fails the gate with no acceptedGrowth record (base is not HEAD)', () => {
  const { root, baseCommit } = createRaisedRepo()
  try {
    for (const env of [{}, { CI: 'true' }]) {
      const run = runGate(root, { env })
      assert.equal(run.status, 1, run.stdout + run.stderr)
      assert.match(run.stderr, /@dzupagent\/alpha\/maxRootIndexLines: moved AWAY from its shrink target \(10 -> 12\)/)
      assert.match(run.stdout, new RegExp(`ratchet base: ${baseCommit} \\(first parent \\(HEAD is on refs/heads/main\\)\\)`))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a committed raise passes once it carries an exact, current acceptedGrowth record', () => {
  const today = new Date().toISOString().slice(0, 10)
  const { root } = createRaisedRepo({
    acceptedGrowth: [{
      key: '@dzupagent/alpha/maxRootIndexLines',
      from: 10,
      to: 12,
      reason: 'Fixture growth accepted to prove the signature path still works.',
      approvedBy: 'Fixture Signer',
      date: today,
    }],
  })
  try {
    const run = runGate(root, { env: { CI: 'true' } })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /Accepted budget growth vs .*: 1/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('on a branch the base is the merge base with main, so every branch commit is ratcheted', () => {
  const root = createFixtureRoot({ indexLines: 5 })
  try {
    git(root, 'init', '-q', '-b', 'main')
    writeBudget(root, { packages: { '@dzupagent/alpha': { maxRootIndexLines: 10 } } })
    const forkPoint = commitAll(root, 'budget')
    git(root, 'checkout', '-q', '-b', 'feature')
    writeBudget(root, { packages: { '@dzupagent/alpha': { maxRootIndexLines: 12 } } })
    commitAll(root, 'raise the budget')
    writeFileSync(join(root, 'notes.txt'), 'later commit on the branch\n', 'utf8')
    commitAll(root, 'unrelated later commit')

    const run = runGate(root, { env: { CI: 'true' } })
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.match(run.stdout, new RegExp(`ratchet base: ${forkPoint} \\(merge-base with refs/heads/main\\)`))
    assert.match(run.stderr, /moved AWAY from its shrink target \(10 -> 12\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('in CI a base equal to HEAD is refused instead of passing with no growth', () => {
  const { root } = createRaisedRepo()
  try {
    const explicitHead = runGate(root, { env: { CI: 'true' }, args: ['--base-ref', 'HEAD'] })
    assert.equal(explicitHead.status, 1, explicitHead.stdout + explicitHead.stderr)
    assert.match(explicitHead.stderr, /ratchet base refused in a non-interactive run: .*HEAD's own commit/)

    // Interactively an explicit HEAD base is still allowed (it checks uncommitted edits only).
    const interactive = runGate(root, { args: ['--base-ref', 'HEAD'] })
    assert.equal(interactive.status, 0, interactive.stdout + interactive.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('in CI a single-commit checkout with no base is refused, not silently skipped', () => {
  const root = createFixtureRoot({ indexLines: 5 })
  try {
    git(root, 'init', '-q', '-b', 'main')
    writeBudget(root, { packages: { '@dzupagent/alpha': { maxRootIndexLines: 10 } } })
    commitAll(root, 'only commit')
    const ci = runGate(root, { env: { CI: 'true' } })
    assert.equal(ci.status, 1, ci.stdout + ci.stderr)
    assert.match(ci.stderr, /ratchet base refused in a non-interactive run/)

    const local = runGate(root)
    assert.equal(local.status, 0, local.stdout + local.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveRatchetBase honours an explicit ref and never defaults to HEAD when a parent exists', () => {
  const { root, baseCommit, headCommit } = createRaisedRepo()
  try {
    const derived = resolveRatchetBase({ root })
    assert.equal(derived.commit, baseCommit)
    assert.equal(derived.equalsHead, false)
    const explicit = resolveRatchetBase({ root, baseRef: 'HEAD' })
    assert.equal(explicit.source, 'explicit')
    assert.equal(explicit.commit, headCommit)
    assert.equal(explicit.equalsHead, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- Live budget coverage (DZUPAGENT-ARCH-M-11) --------------------------------
//
// core had no per-file ceiling, flow-compiler's root barrel was uncapped, four
// packages had no entry at all, and only two star-export barrels had export-count
// caps. These assertions keep the live budget file from regressing to that.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function liveBudgetPackages() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'barrel-budgets.json'), 'utf8')).packages
}

function workspacePackages() {
  const packagesDir = join(REPO_ROOT, 'packages')
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, 'package.json'))
    .filter((manifest) => existsSync(manifest))
    .map((manifest) => ({
      name: JSON.parse(readFileSync(manifest, 'utf8')).name,
      dir: join(manifest, '..'),
    }))
}

test('every packages/* workspace has a budget entry with a per-file ceiling', () => {
  const budgets = liveBudgetPackages()
  const missing = workspacePackages()
    .filter(({ name }) => typeof budgets[name]?.maxFileLines !== 'number')
    .map(({ name }) => name)
  assert.deepEqual(missing, [])
})

test('core carries a per-file ceiling and flow-compiler a root-barrel cap', () => {
  const budgets = liveBudgetPackages()
  assert.equal(budgets['@dzupagent/core'].maxFileLines, 500)
  for (const metric of ['maxRootIndexLines', 'maxRootBarrelExplicitExports', 'maxRootBarrelStarExports']) {
    assert.equal(typeof budgets['@dzupagent/flow-compiler'][metric], 'number', metric)
  }
})

test('every root barrel that uses export-star carries explicit- and star-export caps', () => {
  const budgets = liveBudgetPackages()
  const uncapped = []
  for (const { name, dir } of workspacePackages()) {
    const indexPath = join(dir, 'src', 'index.ts')
    if (!existsSync(indexPath)) continue
    if (!/^\s*export\s+(?:type\s+)?\*\s+from/m.test(readFileSync(indexPath, 'utf8'))) continue
    const budget = budgets[name] ?? {}
    if (typeof budget.maxRootBarrelExplicitExports !== 'number'
      || typeof budget.maxRootBarrelStarExports !== 'number') {
      uncapped.push(name)
    }
  }
  assert.deepEqual(uncapped, [])
})

test('a new export-star line in a capped barrel fails the gate', () => {
  const root = createFixtureRoot({ indexLines: 2 })
  try {
    const budgetConfig = {
      packages: {
        '@dzupagent/alpha': { maxRootBarrelExplicitExports: 2, maxRootBarrelStarExports: 0 },
      },
    }
    assert.equal(evaluateBarrelBudgets({ root, budgetConfig }).ok, true)
    writeFileSync(
      join(root, 'packages', 'alpha', 'src', 'index.ts'),
      "export { thing } from './thing.js'\nexport { thing } from './thing.js'\nexport * from './more.js'\n",
      'utf8',
    )
    const result = evaluateBarrelBudgets({ root, budgetConfig })
    assert.equal(result.ok, false)
    assert.match(result.messages.join('\n'), /maxRootBarrelStarExports exceeded \(measured 1, budget 0\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
