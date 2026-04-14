/**
 * Integration Scorecard module — automated deployment health reports.
 */
export { IntegrationScorecard } from './integration-scorecard.js'
export type {
  ScorecardReport,
  ScorecardCategory,
  ScorecardCheck,
  ScorecardProbeInput,
  IntegrationScorecardOptions,
  Recommendation,
  CheckStatus,
  Grade,
  RecommendationPriority,
} from './integration-scorecard.js'

export { ScorecardReporter, formatConsole, formatMarkdown, formatJSON } from './scorecard-reporter.js'
export type { ScorecardFormat } from './scorecard-reporter.js'
