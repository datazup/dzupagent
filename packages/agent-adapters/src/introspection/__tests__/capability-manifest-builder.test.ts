import { describe, expect, it } from 'vitest'
import type {
  AdapterCapabilityProfile,
  AdapterInstallationRef,
  CatalogEntry,
  InstallationCapabilityDocument,
  ObservedCapabilities,
} from '@dzupagent/adapter-types'
import {
  buildCapabilityManifest,
  computeManifestHash,
  detectCapabilityDrift,
  effectiveCapability,
  reprobeTriggers,
} from '../capability-manifest-builder.js'
import { ClaudeInstallationInspector } from '../claude-inspector.js'
import {
  CLAUDE_HELP_FIXTURE,
  CLAUDE_VERSION_FIXTURE,
  fixedClock,
  ok,
  recordingRunner,
} from './fixtures/probe-fixtures.js'

const BUILT_AT = '2026-08-08T12:00:00.000Z'

const ref: AdapterInstallationRef = {
  installationId: 'inst-qwen-01',
  coordinates: { providerId: 'qwen', backend: 'cli' },
  hostBindingId: 'worker-7',
  managed: true,
}

function profile(
  overrides: Partial<AdapterCapabilityProfile> = {},
): AdapterCapabilityProfile {
  return {
    supportsResume: true,
    supportsFork: false,
    supportsToolCalls: true,
    executesToolLoop: true,
    supportsStreaming: true,
    supportsCostUsage: true,
    ...overrides,
  }
}

function catalog(
  capabilityProfile: AdapterCapabilityProfile = profile(),
): CatalogEntry {
  return {
    coordinates: ref.coordinates,
    displayName: 'Qwen Code',
    capabilityProfile,
    monitorTier: 'partial',
    productIntegrated: true,
    posture: { postureId: 'posture-qwen-cli', version: 1 },
    eventFidelity: {
      raw: true,
      normalized: true,
      artifact: false,
      governance: false,
      usage: 'parsed',
    },
    upstream: { repo: 'QwenLM/qwen-code', docsUrl: 'https://example.invalid' },
  }
}

function observedWindow(
  overrides: Partial<ObservedCapabilities> = {},
): ObservedCapabilities {
  return {
    ref,
    window: { from: '2026-08-08T11:00:00.000Z', to: '2026-08-08T11:59:00.000Z' },
    streamingSeen: null,
    usageReported: null,
    resumeSucceeded: null,
    toolLoopExecuted: null,
    interactionPromptsSeen: null,
    lastSuccessfulRunAt: '2026-08-08T11:58:00.000Z',
    ...overrides,
  }
}

async function claudeDocument(): Promise<InstallationCapabilityDocument> {
  const inspector = new ClaudeInstallationInspector({
    runProbe: recordingRunner({
      'claude --version': ok(CLAUDE_VERSION_FIXTURE),
      'claude --help': ok(CLAUDE_HELP_FIXTURE),
    }).run,
    managedHome: '/managed/home',
    now: () => '2026-08-08T11:55:00.000Z',
  })

  return inspector.inspect({
    installationId: 'inst-claude-01',
    coordinates: { providerId: 'claude', backend: 'cli' },
    hostBindingId: 'worker-7',
    managed: true,
  })
}

describe('buildCapabilityManifest (doc 05 §6)', () => {
  it('marks a never-probed installation stale rather than fresh', () => {
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(),
      installation: null,
      observed: null,
      builtAt: BUILT_AT,
    })

    expect(manifest.installation).toBeNull()
    expect(manifest.staleness.installationStale).toBe(true)
    expect(manifest.staleness.observedStale).toBe(true)
  })

  it('tracks the two staleness flags independently', async () => {
    // A fresh probe with a cold observation window: one flag could not express
    // this, and would have to misreport one side.
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(),
      installation: await claudeDocument(),
      observed: observedWindow({
        window: {
          from: '2026-08-07T00:00:00.000Z',
          to: '2026-08-07T01:00:00.000Z',
        },
      }),
      builtAt: BUILT_AT,
    })

    expect(manifest.staleness.installationStale).toBe(false)
    expect(manifest.staleness.observedStale).toBe(true)
  })

  it('honors the configured staleness thresholds', async () => {
    const installation = await claudeDocument()

    // Probe is 5 minutes old: stale at a 60s floor, fresh at a 3600s floor.
    const strict = buildCapabilityManifest({
      ref,
      catalog: catalog(),
      installation,
      observed: null,
      builtAt: BUILT_AT,
      installationStalenessSeconds: 60,
    })
    const lenient = buildCapabilityManifest({
      ref,
      catalog: catalog(),
      installation,
      observed: null,
      builtAt: BUILT_AT,
      installationStalenessSeconds: 3_600,
    })

    expect(strict.staleness.installationStale).toBe(true)
    expect(lenient.staleness.installationStale).toBe(false)
  })

  it('produces a stable hash for identical content', () => {
    const first = buildCapabilityManifest({
      ref,
      catalog: catalog(),
      installation: null,
      observed: null,
      builtAt: BUILT_AT,
    })
    const second = buildCapabilityManifest({
      ref,
      catalog: catalog(),
      installation: null,
      observed: null,
      builtAt: BUILT_AT,
    })

    expect(first.manifestHash).toBe(second.manifestHash)
    expect(first.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('excludes clock-derived fields from the hash', () => {
    // Two builds a minute apart from identical data are not a content change.
    const earlier = buildCapabilityManifest({
      ref,
      catalog: catalog(),
      installation: null,
      observed: null,
      builtAt: '2026-08-08T12:00:00.000Z',
    })
    const later = buildCapabilityManifest({
      ref,
      catalog: catalog(),
      installation: null,
      observed: null,
      builtAt: '2026-08-08T12:01:00.000Z',
    })

    expect(earlier.manifestHash).toBe(later.manifestHash)
    expect(earlier.builtAt).not.toBe(later.builtAt)
  })

  it('changes the hash when real content changes', () => {
    const streaming = buildCapabilityManifest({
      ref,
      catalog: catalog(profile({ supportsStreaming: true })),
      installation: null,
      observed: null,
      builtAt: BUILT_AT,
    })
    const noStreaming = buildCapabilityManifest({
      ref,
      catalog: catalog(profile({ supportsStreaming: false })),
      installation: null,
      observed: null,
      builtAt: BUILT_AT,
    })

    expect(streaming.manifestHash).not.toBe(noStreaming.manifestHash)
  })

  it('does not depend on property insertion order', () => {
    const base = buildCapabilityManifest({
      ref,
      catalog: catalog(),
      installation: null,
      observed: null,
      builtAt: BUILT_AT,
    })

    const reordered = computeManifestHash({
      observed: base.observed,
      installation: base.installation,
      catalog: base.catalog,
      ref: base.ref,
      schemaVersion: base.schemaVersion,
      builtAt: base.builtAt,
      staleness: base.staleness,
    })

    expect(reordered).toBe(base.manifestHash)
  })
})

describe('detectCapabilityDrift (FR-1.4)', () => {
  it('raises capability-drift when a streaming run contradicts the manifest', () => {
    // The headline AC: a simulated streaming run against a
    // supportsStreaming:false manifest must produce a finding.
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(profile({ supportsStreaming: false })),
      installation: null,
      observed: observedWindow({ streamingSeen: true }),
      builtAt: BUILT_AT,
    })

    const findings = detectCapabilityDrift(manifest, BUILT_AT)

    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe('capability-drift')
    expect(findings[0]!.capability).toBe('streaming')
    expect(findings[0]!.declared).toBe(false)
    expect(findings[0]!.observed).toBe(true)
    expect(findings[0]!.ref.installationId).toBe('inst-qwen-01')
    expect(findings[0]!.summary).toContain('streaming')
  })

  it('raises no finding when observation agrees with the declaration', () => {
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(profile({ supportsStreaming: true })),
      installation: null,
      observed: observedWindow({ streamingSeen: true }),
      builtAt: BUILT_AT,
    })

    expect(detectCapabilityDrift(manifest, BUILT_AT)).toEqual([])
  })

  it('does not treat an unobserved capability as contradicting', () => {
    // Absence of evidence is not evidence of absence: a quiet window must not
    // manufacture a finding against a declared-true capability.
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(profile({ supportsStreaming: true })),
      installation: null,
      observed: observedWindow({ streamingSeen: null }),
      builtAt: BUILT_AT,
    })

    expect(detectCapabilityDrift(manifest, BUILT_AT)).toEqual([])
  })

  it('does not raise a finding when a declared capability was simply not seen', () => {
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(profile({ supportsStreaming: true })),
      installation: null,
      observed: observedWindow({ streamingSeen: false }),
      builtAt: BUILT_AT,
    })

    // Asymmetric by design: seeing it proves support; not seeing it proves
    // nothing about the installation's capability.
    expect(detectCapabilityDrift(manifest, BUILT_AT)).toEqual([])
  })

  it('detects drift on each capability independently', () => {
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(
        profile({
          supportsStreaming: false,
          supportsCostUsage: false,
          supportsResume: true,
        }),
      ),
      installation: null,
      observed: observedWindow({
        streamingSeen: true,
        usageReported: true,
        resumeSucceeded: true,
      }),
      builtAt: BUILT_AT,
    })

    const findings = detectCapabilityDrift(manifest, BUILT_AT)
    const drifted = findings.map((finding) => finding.capability).sort()

    // resume was declared true and observed true, so it must not appear.
    expect(drifted).toEqual(['streaming', 'usageReporting'])
  })

  it('prefers executesToolLoop over the deprecated supportsToolCalls', () => {
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(
        profile({ supportsToolCalls: true, executesToolLoop: false }),
      ),
      installation: null,
      observed: observedWindow({ toolLoopExecuted: true }),
      builtAt: BUILT_AT,
    })

    const findings = detectCapabilityDrift(manifest, BUILT_AT)

    // Reading supportsToolCalls here would miss the contradiction entirely.
    expect(findings.map((finding) => finding.capability)).toEqual(['toolLoop'])
  })

  it('returns no findings when there is no observation layer', () => {
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(profile({ supportsStreaming: false })),
      installation: null,
      observed: null,
      builtAt: BUILT_AT,
    })

    expect(detectCapabilityDrift(manifest, BUILT_AT)).toEqual([])
  })

  it('does not mutate the manifest it inspects', () => {
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(profile({ supportsStreaming: false })),
      installation: null,
      observed: observedWindow({ streamingSeen: true }),
      builtAt: BUILT_AT,
    })
    const before = JSON.stringify(manifest)

    detectCapabilityDrift(manifest, BUILT_AT)

    // Layer 3 never overwrites lower layers.
    expect(JSON.stringify(manifest)).toBe(before)
    expect(manifest.catalog.capabilityProfile.supportsStreaming).toBe(false)
  })
})

describe('reprobeTriggers (FR-1.5)', () => {
  function freshManifest() {
    return buildCapabilityManifest({
      ref,
      catalog: catalog(),
      installation: null,
      observed: null,
      builtAt: BUILT_AT,
      installationStalenessSeconds: 86_400,
    })
  }

  it('fires on a config hash change', () => {
    expect(
      reprobeTriggers({
        manifest: freshManifest(),
        driftFindings: [],
        configHashChanged: true,
      }),
    ).toContain('config-hash-changed')
  })

  it('fires on each declared trigger independently', () => {
    const triggers = reprobeTriggers({
      manifest: freshManifest(),
      driftFindings: [],
      versionChanged: true,
      authFailureSeen: true,
      mcpFailureSeen: true,
    })

    expect(triggers).toContain('version-changed')
    expect(triggers).toContain('auth-failure')
    expect(triggers).toContain('mcp-failure')
    expect(triggers).not.toContain('config-hash-changed')
  })

  it('fires when drift was found', () => {
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(profile({ supportsStreaming: false })),
      installation: null,
      observed: observedWindow({ streamingSeen: true }),
      builtAt: BUILT_AT,
    })
    const findings = detectCapabilityDrift(manifest, BUILT_AT)

    expect(
      reprobeTriggers({ manifest, driftFindings: findings }),
    ).toContain('capability-drift')
  })

  it('fires on a missed staleness floor', () => {
    // A never-probed installation is stale, so it must schedule a probe.
    expect(
      reprobeTriggers({ manifest: freshManifest(), driftFindings: [] }),
    ).toContain('staleness-floor-missed')
  })

  it('returns empty when nothing fired', async () => {
    const manifest = buildCapabilityManifest({
      ref,
      catalog: catalog(),
      installation: await claudeDocument(),
      observed: null,
      builtAt: BUILT_AT,
    })

    expect(reprobeTriggers({ manifest, driftFindings: [] })).toEqual([])
  })
})

describe('effectiveCapability (doc 05 §6 rule 2)', () => {
  it('is the most restrictive of the two layers', () => {
    expect(effectiveCapability(true, true)).toBe(true)
    expect(effectiveCapability(true, false)).toBe(false)
    expect(effectiveCapability(false, true)).toBe(false)
    expect(effectiveCapability(false, false)).toBe(false)
  })

  it('falls back to the catalog when the installation is silent', () => {
    expect(effectiveCapability(true, null)).toBe(true)
    expect(effectiveCapability(false, null)).toBe(false)
  })
})
