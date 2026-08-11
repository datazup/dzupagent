/**
 * Security, isolation, and telemetry posture records (spec doc 08 §2–3).
 *
 * These are *policy input* types: they describe what a provider is capable of
 * and what floor policy must enforce, not what any particular run chose. The
 * governing distinction (doc 08 §2) is control vs boundary — an in-agent
 * permission prompt is a control, never a security boundary. Only
 * worktree/container/VM scoping is a boundary.
 */
import type { AdapterProviderId } from './provider.js'

/**
 * Enforcement boundary a run executes within (FR-6.1).
 *
 * Ordered weakest to strongest; every run request declares its tier and policy
 * resolves the floor from posture × trust context, failing closed before spawn.
 */
export type IsolationTier = 'host' | 'worktree' | 'container' | 'vm'

/**
 * Whether a provider phones home, and whether we can stop it.
 *
 * Doc 08 §2 and doc 05 §4 reference this shape as
 * "documented/enabled/opt-out or unspecified" without giving field-level TS;
 * the structure below is this package's rendering of that gloss, kept
 * `SourcedValue`-free but tri-state so an unprobed posture stays `unknown`
 * rather than defaulting to a reassuring `false`.
 */
export interface TelemetryPosture {
  /** Whether the vendor documents telemetry collection at all. */
  documented: boolean | null
  /** Whether collection is on by default in a fresh install. */
  enabledByDefault: boolean | null
  /** Whether a supported opt-out exists (env var, config key, or flag). */
  optOutAvailable: boolean | null
  /** Config keys/env vars that disable collection, when known. */
  optOutMechanisms: string[]
  /** Where usage numbers originate when this provider reports them. */
  usageSource:
    | 'provider-telemetry'
    | 'local-log'
    | 'wrapper-observed'
    | 'billing-import'
    | 'estimated'
    | 'unspecified'
}

/**
 * Pointer from a catalog entry to its posture record.
 *
 * Catalog entries reference posture by id + version rather than embedding it,
 * so a posture revision does not force a catalog rewrite.
 */
export interface AdapterSecurityPostureRef {
  postureId: string
  /** Monotonic revision of the posture record this entry was built against. */
  version: number
}

/** Minimum isolation policy may not go below, per trust context. */
export interface MinimumIsolationPolicy {
  attended: IsolationTier
  unattended: IsolationTier
  sharedHost: IsolationTier
}

/** Per provider × backend security posture, versioned with the catalog. */
export interface AdapterSecurityPosture {
  postureId: string
  version: number
  coordinates: {
    providerId: AdapterProviderId
    backend: 'cli' | 'sdk' | 'http'
  }
  /**
   * Default approval behavior of a *fresh* install.
   *
   * `unknown` is a real state and must not collapse to `ask`: several CLIs
   * default to auto-approval in headless mode, so an unprobed default is
   * dangerous to assume safe.
   */
  approvalDefault: 'ask' | 'allow' | 'always-approve' | 'mixed' | 'unknown'
  /** Flags that suppress prompts entirely, e.g. `--yolo`, `--always-approve`. */
  dangerousFlags: string[]
  hardSandbox: 'none' | 'container' | 'vm' | 'remote-workspace' | 'configurable'
  minimumIsolation: MinimumIsolationPolicy
  supportsPermissionRules: boolean
  supportsNetworkRestriction: boolean
  /**
   * Config constructs that execute code at load time — e.g. `$(command)`
   * substitution or plugin autoload. Validators must distinguish declarative
   * values from executable substitutions before rendering or applying config.
   */
  configExecutionSurfaces: string[]
  telemetry: TelemetryPosture
  knownRisks: string[]
}
