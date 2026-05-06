#!/usr/bin/env node
/**
 * CLI entry point for the regression gate.
 *
 * Reads two benchmark run JSON files (current and baseline) from the paths
 * provided via CLI arguments, runs the regression gate, and exits with code 1
 * when any suite regresses beyond the threshold.
 *
 * Usage:
 *   node dist/cli/regression-gate.js \
 *     --current  <path-to-current-run.json> \
 *     --baseline <path-to-baseline-run.json> \
 *     [--threshold 0.05]
 *
 * The JSON files must be valid BenchmarkRunRecord objects (as produced by
 * BenchmarkOrchestrator.runSuite).
 *
 * Exit codes:
 *   0 — gate passed (no regressions beyond threshold)
 *   1 — gate failed (one or more suites regressed) or invalid arguments
 */

import { readFileSync } from 'node:fs'
import type { BenchmarkRunRecord } from '@dzupagent/eval-contracts'
import { BenchmarkOrchestrator, RegressionGateError } from '../orchestrator/benchmark-orchestrator.js'
import type { BenchmarkOrchestratorConfig } from '../orchestrator/benchmark-orchestrator.js'

// ---------------------------------------------------------------------------
// Minimal no-op BenchmarkRunStore for the CLI (we do not need persistence)
// ---------------------------------------------------------------------------

const noopStore: BenchmarkOrchestratorConfig['store'] = {
  async saveRun() { /* no-op */ },
  async getRun() { return null },
  async listRuns() { return { data: [], nextCursor: null, hasMore: false } },
  async saveBaseline() { /* no-op */ },
  async getBaseline() { return null },
  async listBaselines() { return [] },
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  currentPath: string
  baselinePath: string
  threshold: number
} {
  let currentPath: string | undefined
  let baselinePath: string | undefined
  let threshold = 0.05

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]

    if (arg === '--current' && next !== undefined) {
      currentPath = next
      i++
    } else if (arg === '--baseline' && next !== undefined) {
      baselinePath = next
      i++
    } else if (arg === '--threshold' && next !== undefined) {
      const parsed = parseFloat(next)
      if (isNaN(parsed) || parsed < 0) {
        process.stderr.write(`Error: --threshold must be a non-negative number, got "${next}"\n`)
        process.exit(1)
      }
      threshold = parsed
      i++
    }
  }

  if (currentPath === undefined) {
    process.stderr.write('Error: --current <path> is required\n')
    process.exit(1)
  }
  if (baselinePath === undefined) {
    process.stderr.write('Error: --baseline <path> is required\n')
    process.exit(1)
  }

  return { currentPath, baselinePath, threshold }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadRunRecord(filePath: string): BenchmarkRunRecord {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    process.stderr.write(`Error: cannot read file "${filePath}": ${String(err)}\n`)
    process.exit(1)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(`Error: invalid JSON in "${filePath}": ${String(err)}\n`)
    process.exit(1)
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('result' in parsed) ||
    typeof (parsed as Record<string, unknown>)['result'] !== 'object'
  ) {
    process.stderr.write(`Error: "${filePath}" does not look like a BenchmarkRunRecord\n`)
    process.exit(1)
  }

  return parsed as BenchmarkRunRecord
}

function main(): void {
  const { currentPath, baselinePath, threshold } = parseArgs(process.argv.slice(2))

  const currentRun = loadRunRecord(currentPath)
  const baselineRun = loadRunRecord(baselinePath)

  // We only need the regressionGate method; pass minimal config
  const orchestrator = new BenchmarkOrchestrator({
    suites: {},
    executeTarget: async () => '',
    store: noopStore,
  })

  try {
    const result = orchestrator.regressionGate({ currentRun, baselineRun, threshold })
    process.stdout.write(
      `Regression gate passed — all ${Object.keys(currentRun.result.scores).length} scorer(s) within threshold (${threshold}).\n`,
    )
    // result.regressions is always [] here but keep for type-check satisfaction
    void result
    process.exit(0)
  } catch (err) {
    if (err instanceof RegressionGateError) {
      process.stderr.write(`${err.message}\n`)
      for (const r of err.regressions) {
        process.stderr.write(
          `  [FAIL] ${r.suiteName}: baseline=${r.baseline.toFixed(4)} current=${r.current.toFixed(4)} delta=${r.delta.toFixed(4)}\n`,
        )
      }
      process.exit(1)
    }
    process.stderr.write(`Unexpected error: ${String(err)}\n`)
    process.exit(1)
  }
}

main()
