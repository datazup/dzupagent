/**
 * Capability manifest assembly and drift detection (spec doc 05 §6, FR-1.4/1.5).
 *
 * Merges the three truth layers into a {@link CapabilityManifest}:
 *   layer 1 catalog (what the framework supports)
 *   layer 2 installation (what is installed, probed)
 *   layer 3 observed (what runs actually did)
 *
 * Two rules from doc 05 are load-bearing here:
 *
 * - **Most-restrictive wins.** Effective capability is the intersection of
 *   layers 1 and 2: the framework cannot exceed what is installed, and an
 *   installation cannot exceed what the framework supports.
 * - **Layer 3 never overwrites.** An observation that contradicts the lower
 *   layers raises a `capability-drift` finding; reconciliation is a re-probe
 *   or a human, never a silent overwrite.
 */
import { canonicalStringify, sha256Prefixed } from '@datazup/canonical-json'

import { ADAPTER_CANONICAL_JSON_OPTIONS } from '../canonical-json-options.js'
import type {
  AdapterInstallationRef,
  CapabilityManifest,
  CatalogEntry,
  Certainty,
  InstallationCapabilityDocument,
  ObservedCapabilities,
  ObservedCapabilityEvidence,
  SourcedValue,
} from '@dzupagent/adapter-types/monitoring/installation'

/** Capability facts that can contradict across layers. */
export type DriftedCapability =
  | 'streaming'
  | 'usageReporting'
  | 'resume'
  | 'toolLoop'

/**
 * A contradiction between observed behavior and declared capability.
 *
 * The finding always records which layer said what, because the repair differs:
 * a wrong catalog is a framework bug, a wrong probe is a stale manifest.
 */
export interface CapabilityDriftFinding {
  kind: 'capability-drift'
  ref: AdapterInstallationRef
  capability: DriftedCapability
  /** What layer 1/2 declared. */
  declared: boolean
  /** What layer 3 observed. */
  observed: boolean
  /** Which layer supplied `declared`. */
  declaredBy: 'catalog' | 'installation'
  /** Evidence source of the effective declaration that won. */
  declaredSource: string
  /** Confidence carried by that winning source. */
  declaredCertainty: Exclude<Certainty, 'unspecified'>
  /** Stable run/event ids backing the contradictory observation. */
  observedEvidence: ObservedCapabilityEvidence | null
  detectedAt: string
  summary: string
}

/** The most-restrictive catalog/installation value with winning provenance. */
export interface EffectiveCapabilityValue {
  value: boolean
  layer: 'catalog' | 'installation'
  source: string
  certainty: Exclude<Certainty, 'unspecified'>
}

export interface BuildManifestInput {
  ref: AdapterInstallationRef
  catalog: CatalogEntry
  /** `null` when the installation has never been probed. */
  installation: InstallationCapabilityDocument | null
  observed: ObservedCapabilities | null
  /** ISO-8601 build timestamp. */
  builtAt: string
  /** Age past which a probe is stale, in seconds. */
  installationStalenessSeconds?: number
  /** Age past which an observation window is stale, in seconds. */
  observedStalenessSeconds?: number
}

const DEFAULT_INSTALLATION_STALENESS_SECONDS = 86_400
const DEFAULT_OBSERVED_STALENESS_SECONDS = 3_600

/**
 * Assemble a manifest from the three layers.
 *
 * A never-probed installation yields `installation: null` with
 * `installationStale: true` — absent data is stale, never fresh.
 */
export function buildCapabilityManifest(
  input: BuildManifestInput,
): CapabilityManifest {
  const installationStale = isStale(
    input.installation?.probedAt ?? null,
    input.builtAt,
    input.installationStalenessSeconds ?? DEFAULT_INSTALLATION_STALENESS_SECONDS,
  )
  const observedStale = isStale(
    input.observed?.window.to ?? null,
    input.builtAt,
    input.observedStalenessSeconds ?? DEFAULT_OBSERVED_STALENESS_SECONDS,
  )

  const manifest: Omit<CapabilityManifest, 'manifestHash'> = {
    schemaVersion: '1.0',
    ref: input.ref,
    catalog: input.catalog,
    installation: input.installation,
    observed: input.observed,
    builtAt: input.builtAt,
    staleness: { installationStale, observedStale },
  }

  return { ...manifest, manifestHash: computeManifestHash(manifest) }
}

/**
 * Content hash for cheap equality and staleness checks.
 *
 * Deliberately excludes `builtAt` and `staleness`: they are derived from the
 * clock rather than from content, so including them would make two manifests
 * built a second apart from identical data look like a content change. Drift
 * *classification* reads the underlying fields — this hash is only for
 * equality (doc 05 §8).
 */
export function computeManifestHash(
  manifest: Omit<CapabilityManifest, 'manifestHash'>,
): string {
  const content = {
    schemaVersion: manifest.schemaVersion,
    ref: manifest.ref,
    catalog: manifest.catalog,
    installation: manifest.installation,
    observed: manifest.observed,
  }

  // Exact port of the private stableStringify this file used to carry
  // (omit undefined entries, elide undefined array items, UTF-16 key
  // order) — corpus-proven byte-identical (ARCH27-T-13).
  return sha256Prefixed(
    canonicalStringify(content, ADAPTER_CANONICAL_JSON_OPTIONS),
  )
}

/**
 * Compare observed behavior against declared capability (FR-1.4).
 *
 * Only a *positive observation contradicting a negative declaration* is drift:
 * having seen streaming proves streaming works. The converse is not symmetric
 * — not having seen streaming in a window is absence of evidence, not evidence
 * the capability is missing, so it never raises a finding.
 */
export function detectCapabilityDrift(
  manifest: CapabilityManifest,
  detectedAt: string,
): CapabilityDriftFinding[] {
  const observed = manifest.observed
  if (observed === null) return []

  const findings: CapabilityDriftFinding[] = []
  const profile = manifest.catalog.capabilityProfile
  const installed = manifest.installation?.capabilities

  const checks: Array<{
    capability: DriftedCapability
    seen: boolean | null
    effective: EffectiveCapabilityValue
    evidence: ObservedCapabilityEvidence | null
    label: string
  }> = [
    {
      capability: 'streaming',
      seen: observed.streamingSeen,
      effective: effectiveCapabilityValue(
        profile.supportsStreaming,
        manifest.catalog.upstream.docsUrl,
        installed?.supportsStreaming,
      ),
      evidence: observed.evidence.streamingSeen,
      label: 'streaming',
    },
    {
      capability: 'usageReporting',
      seen: observed.usageReported,
      effective: effectiveCapabilityValue(
        profile.supportsCostUsage,
        manifest.catalog.upstream.docsUrl,
        installed?.supportsCostUsage,
      ),
      evidence: observed.evidence.usageReported,
      label: 'usage reporting',
    },
    {
      capability: 'resume',
      seen: observed.resumeSucceeded,
      effective: effectiveCapabilityValue(
        profile.supportsResume,
        manifest.catalog.upstream.docsUrl,
        installed?.supportsResume,
      ),
      evidence: observed.evidence.resumeSucceeded,
      label: 'session resume',
    },
    {
      capability: 'toolLoop',
      seen: observed.toolLoopExecuted,
      effective: effectiveCapabilityValue(
        profile.executesToolLoop ?? profile.supportsToolCalls,
        manifest.catalog.upstream.docsUrl,
        installed?.executesToolLoop,
      ),
      evidence: observed.evidence.toolLoopExecuted,
      label: 'tool loop execution',
    },
  ]

  for (const check of checks) {
    if (check.seen === true && check.effective.value === false) {
      findings.push({
        kind: 'capability-drift',
        ref: manifest.ref,
        capability: check.capability,
        declared: false,
        observed: true,
        declaredBy: check.effective.layer,
        declaredSource: check.effective.source,
        declaredCertainty: check.effective.certainty,
        observedEvidence: check.evidence,
        detectedAt,
        summary: `Observed ${check.label} for ${manifest.ref.coordinates.providerId} but the effective ${check.effective.layer} value declares it unsupported.`,
      })
    }
  }

  return findings
}

/** Events that invalidate a probe and require re-inspection (FR-1.5). */
export type ReprobeTrigger =
  | 'binary-drift'
  | 'config-drift'
  | 'recipe-drift'
  | 'operator-demand'
  | 'config-hash-changed'
  | 'version-changed'
  | 'lifecycle-action'
  | 'auth-failure'
  | 'mcp-failure'
  | 'capability-drift'
  | 'staleness-floor-missed'

/**
 * Whether a manifest should be re-probed.
 *
 * Returns the triggers that fired, empty when none did — so a caller can
 * record *why* a re-probe happened rather than just that it did.
 */
export function reprobeTriggers(options: {
  manifest: CapabilityManifest
  driftFindings: readonly CapabilityDriftFinding[]
  configHashChanged?: boolean
  versionChanged?: boolean
  lifecycleActionOccurred?: boolean
  authFailureSeen?: boolean
  mcpFailureSeen?: boolean
  /** Canonical Q3 invalidation inputs. */
  binaryDrift?: boolean
  configDrift?: boolean
  recipeDrift?: boolean
  operatorDemand?: boolean
}): ReprobeTrigger[] {
  const triggers: ReprobeTrigger[] = []

  if (options.binaryDrift === true) triggers.push('binary-drift')
  if (options.configDrift === true) triggers.push('config-drift')
  if (options.recipeDrift === true) triggers.push('recipe-drift')
  if (options.operatorDemand === true) triggers.push('operator-demand')
  if (options.configHashChanged === true) triggers.push('config-hash-changed')
  if (options.versionChanged === true) triggers.push('version-changed')
  if (options.lifecycleActionOccurred === true) triggers.push('lifecycle-action')
  if (options.authFailureSeen === true) triggers.push('auth-failure')
  if (options.mcpFailureSeen === true) triggers.push('mcp-failure')
  if (options.driftFindings.length > 0) triggers.push('capability-drift')
  if (options.manifest.staleness.installationStale) {
    triggers.push('staleness-floor-missed')
  }

  return triggers
}

/**
 * Effective capability for a decision: the most restrictive of layers 1 and 2.
 *
 * `null` when layer 2 has nothing to say, in which case layer 1 stands alone.
 */
export function effectiveCapability(
  catalogSupports: boolean,
  installationSupports: boolean | null,
): boolean {
  if (installationSupports === null) return catalogSupports
  return catalogSupports && installationSupports
}

/** Resolve the effective value and retain the layer that constrained it. */
export function effectiveCapabilityValue(
  catalogSupports: boolean,
  catalogSource: string,
  installationSupports?: SourcedValue<boolean>,
): EffectiveCapabilityValue {
  if (!catalogSupports) {
    return {
      value: false,
      layer: 'catalog',
      source: catalogSource,
      certainty: 'official',
    }
  }

  if (
    installationSupports !== undefined &&
    installationSupports.certainty !== 'unspecified'
  ) {
    return {
      value: installationSupports.value,
      layer: 'installation',
      source: installationSupports.source,
      certainty: installationSupports.certainty,
    }
  }

  return {
    value: true,
    layer: 'catalog',
    source: catalogSource,
    certainty: 'official',
  }
}

function isStale(
  timestamp: string | null,
  now: string,
  thresholdSeconds: number,
): boolean {
  // Absent data is stale, never fresh — phantom green is the worst failure.
  if (timestamp === null) return true

  const ageMs = Date.parse(now) - Date.parse(timestamp)
  if (Number.isNaN(ageMs)) return true

  return ageMs > thresholdSeconds * 1_000
}

/** Key-sorted JSON so hash equality does not depend on property order. */

