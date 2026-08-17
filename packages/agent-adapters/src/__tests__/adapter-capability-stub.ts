import type { AdapterCapabilityProfile } from '../types.js'

/**
 * Minimal conforming `getCapabilities()` return for hand-rolled
 * `AgentCLIAdapter` test doubles.
 *
 * `getCapabilities` is a REQUIRED member of `AgentCLIAdapter`
 * (`adapter-types/src/contracts/execution.ts:344`) — the interface marks its
 * genuinely optional members with `?` (`executeWithRaw?`,
 * `respondInteraction?`), so the omission in 81 doubles across 38 suites was a
 * gap in the doubles, not an over-strict contract. All 19 production adapters
 * implement it.
 *
 * Every capability defaults to `false`. That is deliberate and it is not a
 * behavioural claim about the double it is attached to: no consumer reads
 * capabilities from these doubles today. `candidate-materializer.ts:72` and
 * `memory-enrichment.ts:143` call `adapter.getCapabilities()` *unconditionally*
 * — no optional chaining — so any double reaching those paths without this
 * member would already throw `TypeError: not a function`. The suites are green,
 * which proves those paths are unreached from here. All-false therefore keeps
 * every existing test's behaviour identical while satisfying the type.
 *
 * Pass overrides when a test actually exercises capability-dependent routing,
 * so the declared capability is a real assertion rather than an inherited
 * default:
 *
 * ```ts
 * getCapabilities: () => stubCapabilities({ supportsResume: true })
 * ```
 */
export function stubCapabilities(
  overrides: Partial<AdapterCapabilityProfile> = {}
): AdapterCapabilityProfile {
  return {
    supportsResume: false,
    supportsFork: false,
    supportsToolCalls: false,
    supportsStreaming: false,
    supportsCostUsage: false,
    ...overrides,
  };
}
