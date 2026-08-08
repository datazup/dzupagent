/**
 * Adapter health ladder, failure taxonomy, and health reports (spec doc 06 §2–3).
 *
 * Two principles shape these types:
 *
 * 1. **Derived, not self-reported** — a verdict cites its evidence class; an
 *    agent's own claim of success is never ground truth (FR-2.3).
 * 2. **Staleness is a signal, not a gap** — absent or old data renders as
 *    stale. Phantom green is the worst failure mode, so `skipped` outcomes
 *    carry their reason and are never collapsed into `passed`.
 */
import type { AdapterInstallationRef } from './installation.js'

/**
 * Lifecycle phase a failure occurred in. Distinguishes "we could not install
 * it" from "it ran and misbehaved", which drives very different responses.
 */
export type AdapterFailurePhase =
  | 'detect'
  | 'install'
  | 'configure'
  | 'authenticate'
  | 'start'
  | 'execute'
  | 'probe'
  | 'update'
  | 'rollback'
  | 'stop'

/**
 * A classified failure.
 *
 * `retryable` is *classified, not guessed*: only demonstrably transient codes
 * (rate limits, provider outage, interrupted download, startup race) are
 * retryable. Config-parse failures, permission denials, migration failures,
 * invalid model ids, and anything that may already have mutated files are
 * never auto-retried — those need a clean snapshot first.
 */
export interface AdapterFailure {
  phase: AdapterFailurePhase
  /** Stable code, e.g. `AGENT_NON_ZERO_EXIT`, `AUTH_EXPIRED`, `INFRA_FAULT`. */
  code: string
  retryable: boolean
  exitCode?: number
  signal?: string
  redactedStderr?: string
  /** Pointers to evidence, never the evidence content itself (FR-6.4). */
  evidenceRefs?: string[]
}

/**
 * Rung of the health ladder, cheapest first.
 *
 * L0–L4 are free and run locally on the worker. L5 (provider call) and L6
 * (behavioral canary) consume provider credit, are budgeted, and are off by
 * default — health must never spend model credits out of curiosity (NFR-3).
 */
export type HealthRung = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6'

/**
 * How a rung's verdict was established.
 *
 * `provider-response` is the only class that implies spend; `derived-diff`
 * means the verdict came from comparing two recorded states.
 */
export type HealthEvidenceClass =
  | 'probe'
  | 'artifact'
  | 'provider-response'
  | 'derived-diff'

/**
 * Outcome of a single rung.
 *
 * The two `skipped:*` variants are deliberately distinct: `prerequisite` means
 * a cheaper rung failed and suppressed this one (FR-2.1), while `budget` means
 * the rung was affordable-in-principle but metered out (FR-2.2). Collapsing
 * them would hide budget exhaustion behind an unrelated failure.
 */
export type RungOutcome =
  | 'passed'
  | 'failed'
  | 'skipped:prerequisite'
  | 'skipped:budget'
  | 'skipped:disabled'
  | 'stale'

/** Result of evaluating one rung. */
export interface RungResult {
  rung: HealthRung
  outcome: RungOutcome
  evidenceClass: HealthEvidenceClass
  /** Wall-clock duration of the check in milliseconds. */
  durationMs: number
  /** ISO-8601 timestamp when this rung was evaluated. */
  checkedAt: string
  /** Present when `outcome` is `failed`. */
  failure?: AdapterFailure
  /** Human-readable detail, redacted. */
  detail?: string
}

/**
 * Roll-up verdict for an installation.
 *
 * `unknown` is a first-class state for never-probed or fully-stale
 * installations — it must never be rendered as healthy.
 */
export type HealthOverall =
  | 'healthy'
  | 'degraded'
  | 'misconfigured'
  | 'unavailable'
  | 'updating'
  | 'unknown'

/** Full health verdict for one installation at one point in time. */
export interface AdapterHealthReport {
  ref: AdapterInstallationRef
  rungs: RungResult[]
  overall: HealthOverall
  /** ISO-8601 timestamp when the roll-up was computed. */
  computedAt: string
  /** Highest rung that passed, or `null` when none did. */
  highestRungPassed: HealthRung | null
}

/** Scheduling floor and budget for one rung. */
export interface HealthRungPolicy {
  rung: HealthRung
  /** Rungs that consume provider credit stay off unless explicitly enabled. */
  enabled: boolean
  /**
   * Minimum interval between runs in seconds. A missed floor produces
   * staleness — it is surfaced, never silently served as fresh (FR-2.7).
   */
  floorSeconds: number
  /** Per-window spend ceiling in micro-dollars; `null` for free rungs. */
  budgetMicros: number | null
  /** Timeout for a single evaluation of this rung. */
  timeoutMs: number
}

/** Ladder configuration for an installation or provider class. */
export interface HealthLadderPolicy {
  policyId: string
  version: number
  rungs: HealthRungPolicy[]
  /**
   * Age beyond which a report is reported `stale` regardless of its last
   * outcome. Guards against phantom green from a stopped scheduler.
   */
  stalenessThresholdSeconds: number
}
