/**
 * `@dzupagent/session-control/testing` — reference in-memory implementations
 * and conformance helpers (DZUPAGENT-ARCH-M-14). Hosts that need a durable
 * store or ledger implement the contracts from the root entry point; these
 * reference doubles and fixture validators are not production persistence.
 * The root entry point still re-exports them for compatibility
 * (transitionalRoot in config/public-api-allowlists.json).
 */
export { InMemorySessionStore, type SessionAppendResult, type SessionRegistrationResult } from './in-memory-session-store.js'
export { InMemoryCommandLedger, type CommandRegistrationResult } from './in-memory-command-ledger.js'
export { scanPortableSessionControlValue, validateSessionControlConformanceFixture, type ConformanceResult, type ConformanceSummary, type PortabilityIssue, type PortabilityReport } from './conformance.js'
