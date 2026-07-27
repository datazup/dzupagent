import { describe, it } from 'vitest'

/**
 * COVERAGE GAP — deliberately empty suite.
 *
 * This file previously held 67 `it()` blocks (1474 lines) under a `@ts-nocheck`
 * pragma. Its header claimed escalation was "exercised against the production
 * primitives", but `new EscalationEngine` appeared 58 times against a class
 * DEFINED AT LINE 140 OF THE TEST FILE, while `new ApprovalGate` — the actual
 * shipped primitive — appeared zero times. A repo-wide grep for
 * `class EscalationEngine` returns only this path.
 *
 * All escalation-chain, SLA, cooldown and policy-validation logic under test
 * was local to the file, so 67 tests described a feature that does not ship.
 * `@ts-nocheck` meant TypeScript could not flag the drift either.
 *
 * Genuine ApprovalGate coverage lives in the other hitl-kit suites. If an
 * escalation engine is implemented, test the exported symbol and delete this.
 *
 * Removed 2026-07-27.
 */
describe.skip('EscalationEngine (not implemented — no production symbol exists)', () => {
  it('has no tests because the feature does not ship', () => {})
})
