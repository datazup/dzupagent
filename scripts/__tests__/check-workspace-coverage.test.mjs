import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

import {
  DEFAULT_THRESHOLDS,
  loadCoverageThresholdConfig,
  runCoverageGate,
  selfCheckCoverageGate,
  validateCoverageConfig,
} from '../check-workspace-coverage.mjs'

function makeWorkspace(structure) {
  const root = mkdtempSync(join(tmpdir(), 'dzupagent-coverage-test-'))
  mkdirSync(join(root, 'packages'), { recursive: true })

  for (const [name, data] of Object.entries(structure.packages ?? {})) {
    mkdirSync(join(root, 'packages', name, 'coverage'), { recursive: true })
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({
        name: `@dzupagent/${name}`,
        private: true,
        scripts: data.scripts ?? { 'test:coverage': 'vitest run --coverage' },
      }, null, 2),
    )

    if (data.summary !== null) {
      writeFileSync(
        join(root, 'packages', name, 'coverage', 'coverage-summary.json'),
        JSON.stringify(data.summary, null, 2),
      )
    }
  }

  const configPath = join(root, 'coverage-thresholds.json')
  writeFileSync(configPath, JSON.stringify(structure.config ?? {
    defaultThresholds: DEFAULT_THRESHOLDS,
    trackedPackages: [],
    packages: {},
  }, null, 2))

  return { root, configPath }
}

test('passes when all coverage metrics meet thresholds', () => {
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: {
        summary: {
          total: {
            statements: { total: 100, covered: 85, skipped: 0, pct: 85 },
            branches: { total: 100, covered: 70, skipped: 0, pct: 70 },
            functions: { total: 100, covered: 80, skipped: 0, pct: 80 },
            lines: { total: 100, covered: 86, skipped: 0, pct: 86 },
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 0)
    assert.equal(report.totals.pass, 1)
    assert.equal(report.totals.fail, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when metrics fall below thresholds', () => {
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: {
        summary: {
          total: {
            statements: { total: 100, covered: 50, skipped: 0, pct: 50 },
            branches: { total: 100, covered: 50, skipped: 0, pct: 50 },
            functions: { total: 100, covered: 50, skipped: 0, pct: 50 },
            lines: { total: 100, covered: 50, skipped: 0, pct: 50 },
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 1)
    assert.equal(report.totals.fail, 1)
    assert.match(report.rows[0].message, /coverage below threshold/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('honors temporary waivers', () => {
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: {
        summary: {
          total: {
            statements: { total: 100, covered: 1, skipped: 0, pct: 1 },
            branches: { total: 100, covered: 1, skipped: 0, pct: 1 },
            functions: { total: 100, covered: 1, skipped: 0, pct: 1 },
            lines: { total: 100, covered: 1, skipped: 0, pct: 1 },
          },
        },
      },
    },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          waiver: {
            reason: 'temporary exception for legacy area',
            until: '2099-01-01',
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 0)
    assert.equal(report.totals.waived, 1)
    assert.equal(report.rows[0].status, 'waived')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when coverage summary is missing', () => {
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: { summary: null },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 1)
    assert.equal(report.totals.missing, 1)
    assert.match(report.rows[0].message, /missing coverage summary/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails packages with test but no test:coverage unless tracked or waived', () => {
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: {
        scripts: { test: 'vitest run' },
        summary: null,
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 1)
    assert.equal(report.totals.missing, 1)
    assert.match(report.rows[0].message, /test script but no test:coverage/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('honors waivers for packages with test but no test:coverage', () => {
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: {
        scripts: { test: 'vitest run' },
        summary: null,
      },
    },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          waiver: {
            reason: 'coverage runner not available for this package yet',
            until: '2099-01-01',
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 0)
    assert.equal(report.totals.waived, 1)
    assert.equal(report.rows[0].status, 'waived')
    assert.match(report.rows[0].message, /test script lacks test:coverage; waived/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails packages without coverage scripts even when a staged baseline is configured', () => {
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: {
        scripts: { test: 'vitest run' },
        summary: null,
      },
    },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          baseline: {
            reason: 'coverage runner is being rolled out in stages',
            since: '2026-04-29',
            reviewBy: '2099-01-01',
            targets: [
              {
                by: '2099-02-01',
                requireCoverageScript: true,
                thresholds: { statements: 70, branches: 60, functions: 60, lines: 70 },
              },
            ],
          },
        },
      },
    },
  })

  try {
    // DZUPAGENT-CODE-H-08: a staged baseline concedes a threshold, not the absence
    // of a coverage mechanism. Only an explicit waiver may excuse a package that
    // publishes no `test:coverage` script.
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 1)
    assert.equal(report.totals.baseline, 0)
    assert.equal(report.totals.missing, 1)
    assert.equal(report.rows[0].status, 'missing')
    assert.match(report.rows[0].message, /no test:coverage script/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when coverage drifts below a staged baseline floor', () => {
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: {
        summary: {
          total: {
            statements: { total: 100, covered: 39, skipped: 0, pct: 39 },
            branches: { total: 100, covered: 39, skipped: 0, pct: 39 },
            functions: { total: 100, covered: 39, skipped: 0, pct: 39 },
            lines: { total: 100, covered: 39, skipped: 0, pct: 39 },
          },
        },
      },
    },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          baseline: {
            reason: 'protect current coverage while staged target rises',
            since: '2026-04-29',
            reviewBy: '2099-01-01',
            thresholds: { statements: 40, branches: 40, functions: 40, lines: 40 },
            targets: [
              {
                by: '2099-02-01',
                thresholds: { statements: 70, branches: 60, functions: 60, lines: 70 },
              },
            ],
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 1)
    assert.equal(report.totals.fail, 1)
    assert.match(report.rows[0].message, /coverage below staged baseline/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('self-check mode passes without repo coverage artifacts', async () => {
  const report = await selfCheckCoverageGate()
  assert.equal(report.exitCode, 0)
  assert.equal(report.totals.pass, 1)
  assert.equal(report.totals.waived, 1)
})

test('fails a missing coverage summary even when a staged baseline is configured', () => {
  // DZUPAGENT-CODE-H-08 / DZUPAGENT-TEST-M-14: the gate used to grade an absent
  // summary as `baseline` — a pass — so it exited 0 having measured nothing.
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: { summary: null },
    },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          baseline: {
            reason: 'floor pinned at measured coverage',
            since: '2026-08-04',
            reviewBy: '2099-01-01',
            thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 1)
    assert.equal(report.totals.baseline, 0)
    assert.equal(report.totals.missing, 1)
    assert.equal(report.rows[0].status, 'missing')
    assert.match(report.rows[0].message, /missing coverage summary/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('honors an unexpired noCoverage concession for a missing summary', () => {
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: { summary: null },
    },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          noCoverage: {
            reason: 'coverage runner not yet wired for this package',
            reviewBy: '2099-01-01',
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 0)
    assert.equal(report.totals.missing, 0)
    assert.equal(report.rows[0].status, 'waived')
    assert.match(report.rows[0].message, /no coverage measured; conceded until 2099-01-01/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails an expired noCoverage concession', () => {
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: { summary: null },
    },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          noCoverage: {
            reason: 'coverage runner not yet wired for this package',
            reviewBy: '2020-01-01',
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 1)
    assert.equal(report.totals.expired, 1)
    assert.equal(report.rows[0].status, 'expired')
    assert.match(report.rows[0].message, /noCoverage concession expired 2020-01-01/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a noCoverage concession also covers a package with no test:coverage script', () => {
  const { root, configPath } = makeWorkspace({
    packages: {
      alpha: { scripts: { test: 'vitest run' }, summary: null },
    },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          noCoverage: {
            reason: 'no coverage runner for this package yet',
            reviewBy: '2099-01-01',
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 0)
    assert.equal(report.rows[0].status, 'waived')
    assert.match(report.rows[0].message, /test script lacks test:coverage/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// RF-09 / DZUPAGENT-TEST-C-15: a staged target that points below its own floor asks the team to
// "improve" to a worse number. The gate used to accept 21 of them silently; it must now refuse.
const FULL_COVERAGE_SUMMARY = {
  total: {
    statements: { total: 100, covered: 99, skipped: 0, pct: 99 },
    branches: { total: 100, covered: 99, skipped: 0, pct: 99 },
    functions: { total: 100, covered: 99, skipped: 0, pct: 99 },
    lines: { total: 100, covered: 99, skipped: 0, pct: 99 },
  },
}

test('rejects a staged baseline target that points below its own floor', () => {
  const { root, configPath } = makeWorkspace({
    packages: { alpha: { summary: FULL_COVERAGE_SUMMARY } },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          baseline: {
            reason: 'inverted ratchet probe',
            since: '2026-08-04',
            reviewBy: '2099-01-01',
            thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 },
            targets: [{ by: '2099-01-01', thresholds: DEFAULT_THRESHOLDS }],
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 1)
    assert.equal(report.configErrors.length, 4)
    assert.match(report.configErrors[0], /may not point below its floor/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects an inverted ratchet target even under --report-only', () => {
  const { root, configPath } = makeWorkspace({
    packages: { alpha: { summary: FULL_COVERAGE_SUMMARY } },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 },
          ratchet: {
            since: '2026-08-04',
            reviewBy: '2099-01-01',
            reason: 'inverted ratchet probe',
            target: { statements: 96, branches: 60, functions: 96, lines: 96 },
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath, reportOnly: true })
    assert.equal(report.exitCode, 1, 'report-only must not soften a malformed ratchet')
    assert.equal(report.configErrors.length, 1)
    assert.match(report.configErrors[0], /ratchet\.target branches 60\.00% is below thresholds branches 90\.00%/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a later staged target that walks back an earlier one', () => {
  const { root, configPath } = makeWorkspace({
    packages: { alpha: { summary: FULL_COVERAGE_SUMMARY } },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          baseline: {
            reason: 'regressing ratchet probe',
            since: '2026-08-04',
            reviewBy: '2099-01-01',
            thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
            targets: [
              { by: '2099-01-01', thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 } },
              { by: '2099-06-01', thresholds: { statements: 85, branches: 90, functions: 90, lines: 90 } },
            ],
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.equal(report.exitCode, 1)
    assert.equal(report.configErrors.length, 1)
    assert.match(report.configErrors[0], /baseline\.targets\[1\] statements 85\.00% is below baseline\.targets\[0\] statements 90\.00%/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts a ratchet target at or above its floor', () => {
  const { root, configPath } = makeWorkspace({
    packages: { alpha: { summary: FULL_COVERAGE_SUMMARY } },
    config: {
      defaultThresholds: DEFAULT_THRESHOLDS,
      trackedPackages: [],
      packages: {
        alpha: {
          thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 },
          ratchet: {
            since: '2026-08-04',
            reviewBy: '2099-01-01',
            reason: 'valid ratchet',
            target: { statements: 96, branches: 91, functions: 96, lines: 96 },
          },
        },
      },
    },
  })

  try {
    const report = runCoverageGate({ repoRoot: root, configPath })
    assert.deepEqual(report.configErrors, [])
    assert.equal(report.exitCode, 0)
    assert.equal(report.totals.pass, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the checked-in workspace coverage config has no ratchet inversions', () => {
  const repoRoot = new URL('../../', import.meta.url).pathname
  const config = loadCoverageThresholdConfig(repoRoot)
  assert.deepEqual(validateCoverageConfig(config), [])
})
