import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

import {
  DEFAULT_THRESHOLDS,
  runCoverageGate,
  selfCheckCoverageGate,
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

test('self-check mode passes without repo coverage artifacts', async () => {
  const report = await selfCheckCoverageGate()
  assert.equal(report.exitCode, 0)
  assert.equal(report.totals.pass, 1)
  assert.equal(report.totals.waived, 1)
})
