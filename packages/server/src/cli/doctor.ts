/**
 * `forge doctor` CLI command — comprehensive system diagnostics.
 *
 * Validates environment, connectivity, configuration, and security posture
 * for a DzupAgent server deployment. Each check returns pass/warn/fail
 * and the results are grouped by category with a summary at the end.
 *
 * Supports `--json` for machine-readable output and `--fix` for auto-fixes.
 *
 * This module is a thin coordinator that re-exports from focused siblings:
 *
 * - `doctor-types.ts`              — public types + ANSI helpers
 * - `doctor-checks-env.ts`         — sync env vars + security posture
 * - `doctor-checks-connectivity.ts` — async DB / queue / vector / OTEL probes
 * - `doctor-checks-services.ts`    — async LLM / memory / package version probes
 * - `doctor-runner.ts`             — `runDoctor` + report formatters
 *
 * Existing callers continue to import from `./cli/doctor.js` and see the
 * same surface as before.
 */

// ---------------------------------------------------------------------------
// Public types and helpers
// ---------------------------------------------------------------------------

export type {
  CheckStatus,
  CheckResult,
  CheckCategory,
  DoctorReport,
  DoctorOptions,
  DoctorContext,
} from './doctor-types.js'

// ---------------------------------------------------------------------------
// Runner + formatters (primary entry points)
// ---------------------------------------------------------------------------

export {
  runDoctor,
  formatDoctorReport,
  formatDoctorReportJSON,
} from './doctor-runner.js'
