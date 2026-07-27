import { describe, it } from 'vitest'

/**
 * COVERAGE NOTE — deliberately empty suite.
 *
 * This file previously held 68 `it()` blocks (1255 lines) exercising
 * `CircuitBreaker`, `AdapterRegistry`, `TagBasedRouter`, `RoundRobinRouter` and
 * `CapabilityRouter` — all DEFINED LOCALLY at lines 72-601. Its own header said
 * so: "minimal reference implementations that mirror the contracts ... without
 * adding a dependency on @dzupagent/agent-adapters". Because the copies lived
 * in @dzupagent/connectors, they could not drift-detect against the originals.
 *
 * NOT A GAP. Verified 2026-07-27: every symbol ships in @dzupagent/agent-adapters
 * and is covered there against the real exported classes —
 *   - `ProviderAdapterRegistry` — 44 test files reference it
 *   - `TagBasedRouter` / `RoundRobinRouter` — task-router.test.ts, 54 tests
 *   - `CapabilityRouter` — capability-router.test.ts, 20 tests
 *   - circuit-breaker lifecycle — adapter-registry-circuit-breaker-deep.test.ts,
 *     86 tests
 *
 * An earlier revision of this note claimed the circuit-breaker and routing
 * surface was "uncovered"; that was wrong. Nothing is owed here. This file is
 * retained only so the deletion rationale stays discoverable at the old path,
 * and can be removed once that history is no longer useful.
 *
 * Removed 2026-07-27.
 */
describe.skip('adapter registry / routers (covered in @dzupagent/agent-adapters)', () => {
  it('intentionally empty — real coverage lives in agent-adapters', () => {})
})
