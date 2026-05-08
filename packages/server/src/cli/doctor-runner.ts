/**
 * Doctor runner and output formatters.
 *
 * Composes the individual check modules into a single {@link DoctorReport}
 * and renders it for the terminal (`formatDoctorReport`) or as JSON
 * (`formatDoctorReportJSON`).
 */

import type {
  CheckCategory,
  DoctorContext,
  DoctorOptions,
  DoctorReport,
} from './doctor-types.js'
import { ANSI, statusIcon } from './doctor-types.js'
import { checkEnvVars, checkSecurityPosture } from './doctor-checks-env.js'
import {
  checkDatabaseHealth,
  checkQueueBackend,
  checkTelemetry,
  checkVectorStore,
} from './doctor-checks-connectivity.js'
import {
  checkMemoryService,
  checkModelConfiguration,
  checkPackageVersions,
} from './doctor-checks-services.js'

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full doctor diagnostic and return a structured report.
 *
 * @param ctx  Injectable context with probe functions. All fields are
 *             optional — checks that need a missing dependency will emit
 *             a warning rather than failing.
 * @param options  Output and behavior options (--json, --fix).
 */
export async function runDoctor(
  ctx: DoctorContext = {},
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const fix = options.fix ?? false

  // Run all check categories (some are sync, some async)
  const categories: CheckCategory[] = []

  // 1. Environment
  categories.push(checkEnvVars(ctx, fix))

  // 2-8: async checks — run in parallel for speed
  const [
    modelConfig,
    dbHealth,
    queueBackend,
    vectorStore,
    telemetry,
    memory,
    packageVersions,
  ] = await Promise.all([
    checkModelConfiguration(ctx),
    checkDatabaseHealth(ctx),
    checkQueueBackend(ctx),
    checkVectorStore(ctx),
    checkTelemetry(ctx),
    checkMemoryService(ctx),
    checkPackageVersions(ctx),
  ])

  categories.push(modelConfig)
  categories.push(dbHealth)
  categories.push(queueBackend)
  categories.push(vectorStore)
  categories.push(telemetry)
  categories.push(memory)

  // Security (sync)
  categories.push(checkSecurityPosture(ctx, fix))

  // Package versions (last)
  categories.push(packageVersions)

  // Compute summary
  let passed = 0
  let warnings = 0
  let failures = 0

  for (const cat of categories) {
    for (const check of cat.checks) {
      switch (check.status) {
        case 'pass': passed++; break
        case 'warn': warnings++; break
        case 'fail': failures++; break
      }
    }
  }

  return {
    categories,
    summary: {
      passed,
      warnings,
      failures,
      total: passed + warnings + failures,
    },
    timestamp: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Terminal output formatter
// ---------------------------------------------------------------------------

/**
 * Format a DoctorReport for terminal output with ANSI colors.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = []

  lines.push('')
  lines.push(`${ANSI.bold}${ANSI.cyan}  DzupAgent Doctor${ANSI.reset}`)
  lines.push(`${ANSI.dim}  Comprehensive system diagnostics${ANSI.reset}`)
  lines.push('')

  for (const category of report.categories) {
    lines.push(`${ANSI.bold}  ${category.category}${ANSI.reset}`)

    for (const check of category.checks) {
      const icon = statusIcon(check.status)
      lines.push(`    ${icon} ${check.name}: ${check.message}`)

      if (check.fix) {
        lines.push(`          ${ANSI.dim}fix: ${check.fix}${ANSI.reset}`)
      }
    }
    lines.push('')
  }

  // Summary
  const { passed, warnings, failures, total } = report.summary
  lines.push(`${ANSI.bold}  Summary${ANSI.reset}`)
  lines.push(
    `    ${ANSI.green}${passed} passed${ANSI.reset}, ` +
    `${ANSI.yellow}${warnings} warnings${ANSI.reset}, ` +
    `${ANSI.red}${failures} failures${ANSI.reset} ` +
    `${ANSI.dim}(${total} checks)${ANSI.reset}`,
  )
  lines.push('')

  if (failures > 0) {
    lines.push(`  ${ANSI.red}${ANSI.bold}Some checks failed. Fix the issues above before deploying.${ANSI.reset}`)
  } else if (warnings > 0) {
    lines.push(`  ${ANSI.yellow}All critical checks passed, but some warnings need attention.${ANSI.reset}`)
  } else {
    lines.push(`  ${ANSI.green}All checks passed. System is healthy.${ANSI.reset}`)
  }
  lines.push('')

  return lines.join('\n')
}

/**
 * Format a DoctorReport as a JSON string (for --json flag).
 */
export function formatDoctorReportJSON(report: DoctorReport): string {
  return JSON.stringify(report, null, 2)
}
