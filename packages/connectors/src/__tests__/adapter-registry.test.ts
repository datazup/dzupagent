import { describe, it } from 'vitest'

/**
 * COVERAGE GAP — deliberately empty suite.
 *
 * This file previously held 68 `it()` blocks (1255 lines) exercising
 * `CircuitBreaker`, `AdapterRegistry`, `TagBasedRouter`, `RoundRobinRouter` and
 * `CapabilityRouter` — all DEFINED LOCALLY at lines 72-601. Its own header said
 * so: "minimal reference implementations that mirror the contracts ... without
 * adding a dependency on @dzupagent/agent-adapters".
 *
 * All four routers ship for real, in a DIFFERENT package:
 *   - `ProviderAdapterRegistry` — agent-adapters/src/registry/adapter-registry.ts:59
 *   - `TagBasedRouter`          — agent-adapters/src/registry/task-router.ts:132
 *   - `RoundRobinRouter`        — agent-adapters/src/registry/task-router.ts:307
 *   - `CapabilityRouter`        — agent-adapters/src/registry/capability-router.ts:221
 *
 * Because the copies lived in @dzupagent/connectors, they could not even
 * drift-detect against the originals. Circuit-breaker lifecycle and routing
 * selection remain uncovered by this package; tests belong in agent-adapters,
 * against the exported classes.
 *
 * Removed 2026-07-27.
 */
describe.skip('adapter registry / routers (shipped in agent-adapters, untested here)', () => {
  it('needs tests in @dzupagent/agent-adapters against the real routers', () => {})
})
