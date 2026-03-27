/**
 * CI reaction engine — monitor, route, and fix CI failures.
 */

export {
  categorizeFailure,
  parseGitHubActionsStatus,
  parseCIWebhook,
} from './ci-monitor.js'
export type {
  CIProvider,
  CIStatus,
  CIFailure,
  CIMonitorConfig,
} from './ci-monitor.js'

export {
  routeFailure,
  DEFAULT_FIX_STRATEGIES,
} from './failure-router.js'
export type { FixStrategy } from './failure-router.js'

export {
  generateFixAttempts,
  buildFixPrompt,
} from './fix-loop.js'
export type {
  FixLoopConfig,
  FixAttempt,
  FixLoopResult,
} from './fix-loop.js'
