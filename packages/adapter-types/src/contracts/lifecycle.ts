/**
 * Lifecycle recipes, mutation plans, audit records, and upstream drift
 * classification (spec doc 07).
 *
 * These are *plan* types — declaring what a lifecycle action would do. No
 * mutation happens in this package; the executor lives on the worker.
 *
 * The enrollment boundary (FR-4.1) is the sharpest rule here: lifecycle
 * authority exists only over installations we provisioned or an operator
 * explicitly enrolled. A developer's own `~/.claude` is observe-only — silent
 * mutation of human environments is how work gets destroyed.
 */
import type {
  AdapterCoordinates,
  AdapterInstallationRef,
  CommandSpec,
} from './installation.js'
import type { AdapterFailure } from './health.js'

export type LifecyclePlatform = 'linux' | 'darwin' | 'win32'

/**
 * How to undo an update.
 *
 * `side-by-side` keeps both versions and swaps a symlink atomically. Package
 * managers that cannot install side-by-side (npm -g, brew) must declare
 * `archive-reinstall` instead: archive the previous version, then reinstall
 * the pin on rollback.
 */
export type RollbackStrategy = 'side-by-side' | 'archive-reinstall'

/** Install/update/uninstall procedure for one provider × backend × platform. */
export interface LifecycleRecipe {
  recipeId: string
  coordinates: AdapterCoordinates
  platform: LifecyclePlatform
  /** argv-arrays with `shell: false` — never concatenated command strings. */
  install: CommandSpec[]
  /** `'reinstall'` when the manager has no in-place update path. */
  update: CommandSpec[] | 'reinstall'
  uninstall: CommandSpec[]
  verify: {
    checksumUrlTemplate?: string
    signature?: 'none' | 'sigstore' | 'gpg'
  }
  rollbackStrategy: RollbackStrategy
  /**
   * Recorded **only** so its use can be detected and forbidden.
   *
   * When a binary is manager-owned, letting the agent self-update causes
   * ownership drift that makes rollback non-deterministic (FR-4.4).
   */
  selfUpdaterCommand?: string
  migrationNotes: string[]
  pin: { requested: string; allowedRange?: string }
}

/**
 * States of the update flow (doc 07 §4).
 *
 * Any failure after `staged` transitions to `rolled-back`; a *verification*
 * failure goes to `quarantined`, where the artifact is never executed.
 */
export type LifecyclePhase =
  | 'requested'
  | 'locked'
  | 'inspected'
  | 'resolved'
  | 'verified'
  | 'staged'
  | 'probed'
  | 'backed-up'
  | 'migrated'
  | 'validated'
  | 'canaried'
  | 'activated'
  | 'post-checked'
  | 'committed'
  | 'rolled-back'
  | 'quarantined'
  | 'recorded'

export type LifecycleAction =
  | 'install'
  | 'update'
  | 'rollback'
  | 'uninstall'
  | 'enroll'
  | 'quarantine'

/**
 * Exclusive fenced lock held for a whole lifecycle flow (NFR-7).
 *
 * Recovery is fencing-based: a resumer must present the recorded `nonce`, so a
 * stalled owner cannot later resume and clobber the new one.
 */
export interface LifecycleLock {
  installationId: string
  owner: string
  nonce: string
  /** ISO-8601 expiry. */
  expiresAt: string
}

/** A planned, not-yet-executed lifecycle mutation. */
export interface AdapterLifecyclePlan {
  planId: string
  ref: AdapterInstallationRef
  action: LifecycleAction
  recipeId: string
  /** Version currently active; `null` for a fresh install. */
  fromVersion: string | null
  toVersion: string
  /** Ordered phases this plan intends to traverse. */
  phases: LifecyclePhase[]
  /** Whether a config migration is required as part of this plan. */
  requiresMigration: boolean
  /**
   * Whether production promotion needs human approval (FR-4.6).
   *
   * Upstream drift beyond `new-version` always requires it.
   */
  requiresApproval: boolean
  createdAt: string
}

/** Outcome of executing an {@link AdapterLifecyclePlan}. */
export interface AdapterLifecycleResult {
  planId: string
  ref: AdapterInstallationRef
  /** Phase the flow actually reached — the terminal state on failure. */
  finalPhase: LifecyclePhase
  succeeded: boolean
  /** Version active after the flow, which is `fromVersion` after a rollback. */
  activeVersion: string | null
  failure?: AdapterFailure
  startedAt: string
  finishedAt: string
}

/**
 * One audited transition (NFR-8).
 *
 * Every phase transition writes a record, so a crash can resume from the
 * journal rather than re-deriving what happened.
 */
export interface AdapterLifecycleAuditRecord {
  recordId: string
  planId: string
  ref: AdapterInstallationRef
  phase: LifecyclePhase
  /** Who initiated — operator id or the automation's service identity. */
  actor: string
  /** Authority under which the action was taken (order id, approval id). */
  authority: string
  /** Content hashes captured at this transition, e.g. artifact or config. */
  hashes: Record<string, string>
  outcome: 'ok' | 'failed'
  at: string
  failure?: AdapterFailure
}

/**
 * How an upstream release differs from what we have characterized.
 *
 * Anything past `new-version` implies a contract change that must open a
 * compatibility finding and block automatic production promotion.
 */
export type UpstreamDrift =
  | 'none'
  | 'new-version'
  | 'command-added'
  | 'command-removed'
  | 'flag-changed'
  | 'config-schema-changed'
  | 'config-path-changed'
  | 'credential-contract-changed'
  | 'plugin-contract-changed'
  | 'service-contract-changed'
  | 'telemetry-contract-changed'
  | 'breaking-migration'

/** A detected upstream change awaiting classification and approval. */
export interface UpstreamDriftFinding {
  findingId: string
  coordinates: AdapterCoordinates
  drift: UpstreamDrift
  observedVersion: string
  /** Version the finding was diffed against. */
  baselineVersion: string
  /** Redacted human-readable summary of the difference. */
  summary: string
  detectedAt: string
  /**
   * Which support matrix this version sits in. `pinned-stable` failures block
   * promotion; `floating-upstream` failures open findings and quarantine.
   */
  matrix: 'pinned-stable' | 'floating-upstream'
}
