/**
 * @dzupagent/server/ops — operational diagnostics and health-reporting facade.
 *
 * This subpath gives doctor and scorecard helpers an explicit non-root home
 * while the root entrypoint remains temporarily compatible during migration.
 */

// --- Doctor ---
export { runDoctor, formatDoctorReport, formatDoctorReportJSON } from './cli/doctor.js'
export type {
  CheckStatus,
  CheckResult,
  CheckCategory,
  DoctorReport,
  DoctorOptions,
  DoctorContext,
} from './cli/doctor.js'

// --- Scorecard CLI ---
export { runScorecard, parseScorecardArgs } from './cli/scorecard-command.js'
export type { ScorecardCommandOptions, ScorecardCommandResult } from './cli/scorecard-command.js'

// --- Scorecard API ---
export { IntegrationScorecard } from './scorecard/index.js'
export type {
  ScorecardReport,
  ScorecardCategory,
  ScorecardCheck,
  ScorecardProbeInput,
  Recommendation,
  Grade,
  RecommendationPriority,
} from './scorecard/index.js'
export type { CheckStatus as ScorecardCheckStatus } from './scorecard/index.js'
export { ScorecardReporter, formatConsole, formatMarkdown, formatJSON } from './scorecard/index.js'
export type { ScorecardFormat } from './scorecard/index.js'
