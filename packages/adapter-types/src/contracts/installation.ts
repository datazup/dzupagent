/**
 * Installation identity, probed capability documents, and the merged
 * capability manifest (spec doc 05).
 *
 * Three-layer truth model (D-04):
 *   layer 1 = catalog (framework-versioned, what we ship support for)
 *   layer 2 = {@link InstallationCapabilityDocument} (probed from the host)
 *   layer 3 = {@link ObservedCapabilities} (derived from run events)
 *
 * The binding rule across all three is **null-not-guessed**: a fact the probe
 * could not evidence is `{ value: null, certainty: 'unspecified' }`, never an
 * assumed default. Consumers must render unknown as unknown — the same honesty
 * contract the dashboard's nullable metrics carry.
 */
import type { AdapterProviderId } from './provider.js'
import type { AdapterCapabilityProfile } from './execution.js'
import type { TelemetryPosture, AdapterSecurityPostureRef } from './posture.js'

/**
 * How an adapter is executed. Only `cli` backends have full installation
 * records; `sdk` backends carry a package descriptor and `http` backends an
 * endpoint descriptor.
 */
export type AdapterExecutionBackend = 'cli' | 'sdk' | 'http'

/** Provider + backend pair identifying a kind of adapter (not an instance). */
export interface AdapterCoordinates {
  providerId: AdapterProviderId
  backend: AdapterExecutionBackend
}

/** Host-bound installed unit — one concrete, addressable installation. */
export interface AdapterInstallationRef {
  /** Stable, host-scoped identifier. */
  installationId: string
  coordinates: AdapterCoordinates
  /** Registered worker/host identity — never a raw hostname or path (FR-6.4). */
  hostBindingId: string
  /** Provisioned/enrolled by us ⇒ lifecycle-eligible. */
  managed: boolean
}

/**
 * How much we trust a fact.
 *
 * `official` = vendor documentation or machine-readable manifest;
 * `observed` = seen in a probe or run; `inferred` = derived from adjacent
 * evidence; `unspecified` = not evidenced (the only certainty permitted
 * alongside a `null` value).
 */
export type Certainty = 'official' | 'observed' | 'inferred' | 'unspecified'

/** A fact declared by an authoritative vendor or machine-readable source. */
export interface OfficialSourcedValue<T> {
  value: NonNullable<T>
  certainty: 'official'
  /** Doc URL or manifest id backing the declaration. */
  source: string
  observedAt?: never
}

/** A fact directly evidenced by a probe or run event. */
export interface ObservedSourcedValue<T> {
  value: NonNullable<T>
  certainty: 'observed'
  /** Probe id or event id backing the value. */
  source: string
  /** ISO-8601 timestamp at which the fact was observed. */
  observedAt: string
}

/** A fact derived from adjacent, identified evidence. */
export interface InferredSourcedValue<T> {
  value: NonNullable<T>
  certainty: 'inferred'
  /** Evidence id from which the value was inferred. */
  source: string
  /** ISO-8601 timestamp at which the inference was made. */
  observedAt: string
}

/** An unevidenced fact: it has no value and may carry no provenance. */
export interface UnspecifiedSourcedValue {
  value: null
  certainty: 'unspecified'
  source?: never
  observedAt?: never
}

/**
 * A single fact plus structurally valid provenance.
 *
 * The discriminated union makes the null-not-guessed rule compile-time
 * enforceable: known values require evidence, observations require a
 * timestamp, and an unspecified value cannot carry a guessed value or source.
 */
export type SourcedValue<T> =
  | OfficialSourcedValue<T>
  | ObservedSourcedValue<T>
  | InferredSourcedValue<T>
  | UnspecifiedSourcedValue

/** How a binary arrived on the host; drives lifecycle recipe selection. */
export type BinaryOwnership =
  | 'npm'
  | 'brew'
  | 'pipx'
  | 'uv'
  | 'binary'
  | 'script'
  | 'docker'
  | 'go'
  | 'unknown'

/** A subcommand discovered by walking `--help`. */
export interface CommandSpec {
  /** Invocation path, e.g. `['mcp', 'add']`. */
  path: string[]
  /** First help line, redacted; absent when help produced no summary. */
  summary?: string
  /** Flags observed in this node's help output. */
  flags?: string[]
}

/**
 * Command tree assembled from `--help` walks.
 *
 * Only nodes actually observed appear here: the prober never invokes a
 * subcommand it did not first see advertised.
 */
export interface ProbedCommandTree {
  root: CommandSpec
  subcommands: CommandSpec[]
}

/**
 * Management verbs observed to exist for this version.
 *
 * Each verb is a {@link SourcedValue} because several agents leave
 * update/remove unspecified — those must be version-gated, never assumed.
 */
export interface ProbedCrud {
  list: SourcedValue<CommandSpec>
  install: SourcedValue<CommandSpec>
  update: SourcedValue<CommandSpec>
  remove: SourcedValue<CommandSpec>
  authenticate: SourcedValue<CommandSpec>
}

/** Where configuration is read from, and with what precedence. */
export type ConfigScope =
  | 'managed-policy'
  | 'remote'
  | 'user'
  | 'workspace'
  | 'project'
  | 'environment'
  | 'invocation'

export type ConfigFormat =
  | 'json'
  | 'jsonc'
  | 'yaml'
  | 'toml'
  | 'dotenv'
  | 'dsl'
  | 'sqlite'

/**
 * One configuration source in the precedence chain.
 *
 * A higher layer may make policy *more* restrictive without approval;
 * loosening requires an audited authorization decision (doc 05 §7).
 */
export interface ConfigLayer {
  id: string
  scope: ConfigScope
  /** Absolute only inside worker-local records; an opaque ref in DTOs (FR-6.4). */
  path?: string
  format: ConfigFormat
  precedence: number
  exists: boolean
  writable: boolean
  sha256?: string
  schemaUrl?: string
  /** Migration input only — never written back. */
  legacy?: boolean
}

/** How a credential is supplied. Presence only; values are never read. */
export interface CredentialBinding {
  /** Logical name, e.g. `anthropic-api-key`. */
  name: string
  /** Environment variables the CLI accepts for this binding. */
  acceptedEnvVars: string[]
  storage: 'env' | 'file' | 'keychain' | 'oauth' | 'unknown'
  /** Presence only — the value is never read, logged, or hashed. */
  configured: SourcedValue<boolean>
}

/** Layer 2 — what a specific installation on a specific host can actually do. */
export interface InstallationCapabilityDocument {
  schemaVersion: '1.0'
  ref: AdapterInstallationRef
  /** ISO-8601 timestamp of the probe. */
  probedAt: string
  /** Version of the inspector that produced this document. */
  probeToolVersion: string

  binary: {
    path: SourcedValue<string>
    version: SourcedValue<string>
    /** Unparsed `--version` output, retained for parser fixtures. */
    versionRaw?: string
    ownership: SourcedValue<BinaryOwnership>
    executable: boolean
  }

  commands: ProbedCommandTree
  configLayers: ConfigLayer[]
  credentials: CredentialBinding[]

  extensions: {
    plugins: {
      supported: SourcedValue<boolean>
      locations: string[]
      crud: ProbedCrud
    }
    skills: {
      supported: SourcedValue<boolean>
      standard: 'agent-skills' | 'custom' | 'none'
      locations: string[]
    }
    mcp: {
      supported: SourcedValue<boolean>
      transports: ('stdio' | 'http' | 'sse')[]
      crud: ProbedCrud
    }
    hooks: { supported: SourcedValue<boolean>; locations: string[] }
  }

  runtimeModes: {
    oneShot: SourcedValue<boolean>
    structuredOutput: SourcedValue<'json' | 'jsonl' | 'text' | 'unspecified'>
    acp: SourcedValue<boolean>
    httpServer: SourcedValue<boolean>
    daemon: SourcedValue<boolean>
  }

  security: {
    approvalDefault: SourcedValue<'ask' | 'allow' | 'always-approve' | 'mixed'>
    permissionRules: SourcedValue<boolean>
    /** Verified by snapshot probe (FR-4.7), never assumed from documentation. */
    xdgOverrideHonored: SourcedValue<boolean>
  }

  telemetry: TelemetryPosture

  /**
   * Capability facts evidenced for this concrete installation.
   *
   * Older probe documents may omit this block. An omitted fact is unknown and
   * therefore leaves the catalog value in force; it must never be interpreted
   * as `false`.
   */
  capabilities?: {
    supportsStreaming?: SourcedValue<boolean>
    supportsCostUsage?: SourcedValue<boolean>
    supportsResume?: SourcedValue<boolean>
    executesToolLoop?: SourcedValue<boolean>
  }

  /** Raw help capture is stored out-of-band; the document carries only its hash. */
  rawProbes: { helpSha256: string; capturePath: string }
}

/** Depth of introspection a provider supports (April capability matrix). */
export type MonitorTier = 'deep' | 'partial' | 'artifact-backed' | 'none'

/** Which telemetry planes an adapter can populate. */
export interface EventFidelity {
  raw: boolean
  normalized: boolean
  artifact: boolean
  governance: boolean
  usage: 'native' | 'parsed' | 'none'
}

/** Layer 1 — what the framework ships support for, versioned with the framework. */
export interface CatalogEntry {
  coordinates: AdapterCoordinates
  displayName: string
  capabilityProfile: AdapterCapabilityProfile
  monitorTier: MonitorTier
  /** Gated by the doc 09 admission contract. */
  productIntegrated: boolean
  posture: AdapterSecurityPostureRef
  /** Required for managed `cli` installations (doc 07 §3). */
  lifecycleRecipeRef?: string
  eventFidelity: EventFidelity
  upstream: { repo: string; docsUrl: string; releaseFeed?: string }
}

/**
 * Layer 3 — capabilities derived from observed run events.
 *
 * Every field is tri-state: `true`/`false` are observations, `null` means the
 * window contained no evidence either way. Layer 3 never silently overwrites
 * layers 1–2; a contradiction raises a `capability-drift` finding (FR-1.4) and
 * is reconciled by a re-probe or a human.
 */
export interface ObservedCapabilities {
  ref: AdapterInstallationRef
  window: { from: string; to: string }
  /** Complete only when every included run has a start and terminal event. */
  completeness: 'complete' | 'partial'
  streamingSeen: boolean | null
  usageReported: boolean | null
  resumeSucceeded: boolean | null
  toolLoopExecuted: boolean | null
  interactionPromptsSeen: boolean | null
  lastSuccessfulRunAt: string | null
  /** Stable event/run identifiers backing each derived fact. */
  evidence: {
    streamingSeen: ObservedCapabilityEvidence | null
    usageReported: ObservedCapabilityEvidence | null
    resumeSucceeded: ObservedCapabilityEvidence | null
    toolLoopExecuted: ObservedCapabilityEvidence | null
    interactionPromptsSeen: ObservedCapabilityEvidence | null
    lastSuccessfulRunAt: ObservedCapabilityEvidence | null
  }
}

/** Provenance retained from normalized run events without retaining payloads. */
export interface ObservedCapabilityEvidence {
  eventIds: string[]
  runIds: string[]
}

/**
 * The merged view consumers read from (FR-1.3).
 *
 * Effective capability for a decision is the *most restrictive* of layers 1
 * and 2 — the framework cannot exceed what is installed, and an installation
 * cannot exceed what the framework supports — with layer 3 as veto evidence.
 */
export interface CapabilityManifest {
  schemaVersion: '1.0'
  ref: AdapterInstallationRef
  /** Layer 1 as it stood at manifest build time. */
  catalog: CatalogEntry
  /** `null` for a never-probed installation. */
  installation: InstallationCapabilityDocument | null
  observed: ObservedCapabilities | null
  /**
   * Content hash for cheap equality and staleness checks only.
   *
   * Drift *classification* reads the underlying fields: comparing a derived
   * hash alongside its own sources makes a format change read as a content
   * change (doc 05 §8).
   */
  manifestHash: string
  builtAt: string
  staleness: { installationStale: boolean; observedStale: boolean }
}
