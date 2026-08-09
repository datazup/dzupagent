import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AdapterCoordinates,
  AdapterFailure,
  AdapterHealthReport,
  AdapterInstallationRef,
  AdapterLifecyclePlan,
  AdapterSecurityPosture,
  CapabilityManifest,
  Certainty,
  HealthOverall,
  InstallationCapabilityDocument,
  IsolationTier,
  ObservedCapabilities,
  RungOutcome,
  RungResult,
  SourcedValue,
  TelemetryPosture,
  UpstreamDrift,
} from '../index.js'

const ref: AdapterInstallationRef = {
  installationId: 'inst-claude-01',
  coordinates: { providerId: 'claude', backend: 'cli' },
  hostBindingId: 'worker-7',
  managed: true,
}

describe('installation contracts (doc 05)', () => {
  it('exposes provider coordinates through the package surface', () => {
    const coordinates: AdapterCoordinates = {
      providerId: 'codex',
      backend: 'sdk',
    }

    expect(coordinates.providerId).toBe('codex')
    expect(coordinates.backend).toBe('sdk')
  })

  it('binds installation records to a host identity rather than a hostname', () => {
    // FR-6.4: DTOs carry a registered binding id, never a raw host path.
    expect(ref.hostBindingId).toBe('worker-7')
    expect(ref.managed).toBe(true)
  })

  it('rejects an execution backend outside the cli/sdk/http union', () => {
    expectTypeOf<AdapterCoordinates['backend']>().toEqualTypeOf<
      'cli' | 'sdk' | 'http'
    >()

    const invalid: AdapterCoordinates = {
      providerId: 'claude',
      // @ts-expect-error 'ssh' is not a supported execution backend
      backend: 'ssh',
    }
    void invalid
  })

  it('carries an unevidenced fact as null with unspecified certainty', () => {
    // The null-not-guessed rule: absence of evidence is recorded, not defaulted.
    const unprobed: SourcedValue<string> = {
      value: null,
      certainty: 'unspecified',
    }

    expect(unprobed.value).toBeNull()
    expect(unprobed.certainty).toBe('unspecified')
    expect(unprobed.source).toBeUndefined()
    expect(unprobed.observedAt).toBeUndefined()
  })

  it('distinguishes an observed false from an unprobed unknown', () => {
    // This is the distinction the whole honesty contract rests on: a probe that
    // proved a feature absent must not be confused with never having looked.
    const observedAbsent: SourcedValue<boolean> = {
      value: false,
      certainty: 'observed',
      source: 'probe:claude-help-v2',
      observedAt: '2026-08-08T10:00:00.000Z',
    }
    const neverProbed: SourcedValue<boolean> = {
      value: null,
      certainty: 'unspecified',
    }

    expect(observedAbsent.value).toBe(false)
    expect(neverProbed.value).toBeNull()
    expect(observedAbsent.value).not.toBe(neverProbed.value)
    expect(observedAbsent.certainty).not.toBe(neverProbed.certainty)
  })

  it('admits exactly the four certainty levels', () => {
    expectTypeOf<Certainty>().toEqualTypeOf<
      'official' | 'observed' | 'inferred' | 'unspecified'
    >()

    // @ts-expect-error 'probably' is not a certainty level
    const invalid: Certainty = 'probably'
    void invalid
  })

  it('requires valid provenance for every sourced-value state', () => {
    const official: SourcedValue<string> = {
      value: 'documented',
      certainty: 'official',
      source: 'docs://provider/capabilities',
    }
    const observed: SourcedValue<string> = {
      value: '2.1.0',
      certainty: 'observed',
      source: 'probe:version',
      observedAt: '2026-08-08T10:00:00.000Z',
    }
    const inferred: SourcedValue<boolean> = {
      value: true,
      certainty: 'inferred',
      source: 'evidence:command-tree/mcp',
      observedAt: '2026-08-08T10:00:00.000Z',
    }
    const unspecified: SourcedValue<string> = {
      value: null,
      certainty: 'unspecified',
    }

    expect(official.certainty).toBe('official')
    expect(observed.observedAt).toBe('2026-08-08T10:00:00.000Z')
    expect(inferred.source).toBe('evidence:command-tree/mcp')
    expect(unspecified.value).toBeNull()
  })

  it('rejects impossible sourced-value combinations at compile time', () => {
    // @ts-expect-error official declarations require an evidence source
    const officialWithoutSource: SourcedValue<string> = {
      value: 'documented',
      certainty: 'official',
    }
    // @ts-expect-error observed facts require an observation timestamp
    const observationWithoutTimestamp: SourcedValue<string> = {
      value: '2.1.0',
      certainty: 'observed',
      source: 'probe:version',
    }
    // @ts-expect-error inferred facts require identified evidence
    const inferenceWithoutSource: SourcedValue<boolean> = {
      value: true,
      certainty: 'inferred',
      observedAt: '2026-08-08T10:00:00.000Z',
    }
    // @ts-expect-error unspecified facts cannot carry a guessed value
    const guessedUnknown: SourcedValue<string> = {
      value: 'probably-present',
      certainty: 'unspecified',
    }
    // @ts-expect-error unspecified facts cannot carry provenance
    const sourcedUnknown: SourcedValue<string> = {
      value: null,
      certainty: 'unspecified',
      source: 'probe:missing',
    }
    // @ts-expect-error known facts cannot use null as their value
    const nullObservation: SourcedValue<string | null> = {
      value: null,
      certainty: 'observed',
      source: 'probe:version',
      observedAt: '2026-08-08T10:00:00.000Z',
    }

    void officialWithoutSource
    void observationWithoutTimestamp
    void inferenceWithoutSource
    void guessedUnknown
    void sourcedUnknown
    void nullObservation
  })

  it('pins the capability document to schema version 1.0', () => {
    expectTypeOf<
      InstallationCapabilityDocument['schemaVersion']
    >().toEqualTypeOf<'1.0'>()

    // @ts-expect-error schemaVersion is a literal, so an unversioned document is rejected
    const invalid: InstallationCapabilityDocument['schemaVersion'] = '1'
    void invalid
  })
})

describe('CapabilityManifest (doc 05 §6)', () => {
  const observed: ObservedCapabilities = {
    ref,
    window: {
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-08T00:00:00.000Z',
    },
    completeness: 'complete',
    streamingSeen: true,
    usageReported: null,
    resumeSucceeded: null,
    toolLoopExecuted: true,
    interactionPromptsSeen: null,
    lastSuccessfulRunAt: '2026-08-07T22:15:00.000Z',
    evidence: {
      streamingSeen: { eventIds: ['event-stream-1'], runIds: ['run-1'] },
      usageReported: null,
      resumeSucceeded: null,
      toolLoopExecuted: { eventIds: ['event-tool-1'], runIds: ['run-1'] },
      interactionPromptsSeen: null,
      lastSuccessfulRunAt: { eventIds: ['event-complete-1'], runIds: ['run-1'] },
    },
  }

  it('represents a never-probed installation as null rather than an empty document', () => {
    // An empty document would assert "we probed and found nothing"; null says
    // "we have not probed", which is a different fact.
    const manifest: CapabilityManifest = {
      schemaVersion: '1.0',
      ref,
      catalog: {
        coordinates: ref.coordinates,
        displayName: 'Claude Code',
        capabilityProfile: {
          supportsResume: true,
          supportsFork: true,
          supportsToolCalls: true,
          executesToolLoop: true,
          supportsStreaming: true,
          supportsCostUsage: true,
        },
        monitorTier: 'deep',
        productIntegrated: true,
        posture: { postureId: 'posture-claude-cli', version: 3 },
        eventFidelity: {
          raw: true,
          normalized: true,
          artifact: true,
          governance: true,
          usage: 'native',
        },
        upstream: {
          repo: 'anthropics/claude-code',
          docsUrl: 'https://docs.claude.com/claude-code',
        },
      },
      installation: null,
      observed: null,
      manifestHash: 'sha256:0f1e2d',
      builtAt: '2026-08-08T12:00:00.000Z',
      staleness: { installationStale: true, observedStale: true },
    }

    expect(manifest.installation).toBeNull()
    expect(manifest.observed).toBeNull()
    expect(manifest.staleness.installationStale).toBe(true)
  })

  it('keeps observed capabilities tri-state so no evidence stays distinct from negative evidence', () => {
    expect(observed.streamingSeen).toBe(true)
    expect(observed.usageReported).toBeNull()
    expect(observed.resumeSucceeded).toBeNull()
    expect(observed.toolLoopExecuted).toBe(true)
  })

  it('tracks installation and observed staleness independently', () => {
    // A fresh probe with a cold event window is a real state; one flag would
    // force it to be misreported as wholly stale or wholly fresh.
    const staleness: CapabilityManifest['staleness'] = {
      installationStale: false,
      observedStale: true,
    }

    expect(staleness.installationStale).toBe(false)
    expect(staleness.observedStale).toBe(true)
  })

  it('rejects an observed-capability field that is merely absent', () => {
    // Omission must not typecheck: the field has to say null explicitly.
    // @ts-expect-error streamingSeen is required even when unknown
    const invalid: ObservedCapabilities = {
      ref,
      window: observed.window,
      usageReported: null,
      resumeSucceeded: null,
      toolLoopExecuted: null,
      interactionPromptsSeen: null,
      lastSuccessfulRunAt: null,
    }
    void invalid
  })
})

describe('health contracts (doc 06 §2-3)', () => {
  it('separates a budget skip from a prerequisite skip', () => {
    // Collapsing these would hide budget exhaustion behind an unrelated failure.
    const budgetSkip: RungResult = {
      rung: 'L5',
      outcome: 'skipped:budget',
      evidenceClass: 'derived-diff',
      durationMs: 0,
      checkedAt: '2026-08-08T12:00:00.000Z',
    }
    const prerequisiteSkip: RungResult = {
      rung: 'L6',
      outcome: 'skipped:prerequisite',
      evidenceClass: 'derived-diff',
      durationMs: 0,
      checkedAt: '2026-08-08T12:00:00.000Z',
    }

    expect(budgetSkip.outcome).toBe('skipped:budget')
    expect(prerequisiteSkip.outcome).toBe('skipped:prerequisite')
    expect(budgetSkip.outcome).not.toBe(prerequisiteSkip.outcome)
  })

  it('does not admit a skip outcome that hides why the rung was skipped', () => {
    expectTypeOf<RungOutcome>().toEqualTypeOf<
      | 'passed'
      | 'failed'
      | 'skipped:prerequisite'
      | 'skipped:budget'
      | 'skipped:disabled'
      | 'stale'
    >()

    // @ts-expect-error a bare 'skipped' would erase the reason
    const invalid: RungOutcome = 'skipped'
    void invalid
  })

  it('reports a never-probed installation as unknown, never as healthy', () => {
    const report: AdapterHealthReport = {
      ref,
      rungs: [],
      overall: 'unknown',
      computedAt: '2026-08-08T12:00:00.000Z',
      highestRungPassed: null,
    }

    expect(report.overall).toBe('unknown')
    expect(report.highestRungPassed).toBeNull()
    expect(report.rungs).toHaveLength(0)
  })

  it('keeps unknown inside the overall union so phantom green is unrepresentable', () => {
    expectTypeOf<HealthOverall>().toEqualTypeOf<
      | 'healthy'
      | 'degraded'
      | 'misconfigured'
      | 'unavailable'
      | 'updating'
      | 'unknown'
    >()

    // @ts-expect-error 'ok' is not a health verdict
    const invalid: HealthOverall = 'ok'
    void invalid
  })

  it('classifies retryability explicitly on every failure', () => {
    const configFailure: AdapterFailure = {
      phase: 'configure',
      code: 'CONFIG_PARSE',
      retryable: false,
    }
    const transientFailure: AdapterFailure = {
      phase: 'execute',
      code: 'RATE_LIMIT',
      retryable: true,
    }

    expect(configFailure.retryable).toBe(false)
    expect(transientFailure.retryable).toBe(true)
  })

  it('carries evidence as pointers and never as content', () => {
    const failure: AdapterFailure = {
      phase: 'probe',
      code: 'AGENT_NON_ZERO_EXIT',
      retryable: false,
      exitCode: 2,
      evidenceRefs: ['capture://probes/claude/2.1.0/help'],
    }

    expect(failure.evidenceRefs).toEqual(['capture://probes/claude/2.1.0/help'])
    expect(failure).not.toHaveProperty('stderr')
  })
})

describe('posture contracts (doc 08 §2-3)', () => {
  it('keeps an unprobed approval default as unknown rather than assuming ask', () => {
    // Several CLIs auto-approve in headless mode, so an unprobed default that
    // silently reads as 'ask' would understate the risk.
    const posture: AdapterSecurityPosture['approvalDefault'] = 'unknown'

    expect(posture).toBe('unknown')
    expect(posture).not.toBe('ask')
  })

  it('orders isolation tiers from host to vm', () => {
    expectTypeOf<IsolationTier>().toEqualTypeOf<
      'host' | 'worktree' | 'container' | 'vm'
    >()

    // @ts-expect-error a permission prompt is a control, not an isolation tier
    const invalid: IsolationTier = 'permission-prompt'
    void invalid
  })

  it('leaves telemetry posture tri-state when the vendor is silent', () => {
    const unknownTelemetry: TelemetryPosture = {
      documented: null,
      enabledByDefault: null,
      optOutAvailable: null,
      optOutMechanisms: [],
      usageSource: 'unspecified',
    }

    expect(unknownTelemetry.enabledByDefault).toBeNull()
    expect(unknownTelemetry.enabledByDefault).not.toBe(false)
    expect(unknownTelemetry.usageSource).toBe('unspecified')
  })

  it('tags estimated usage distinctly from provider-reported usage', () => {
    // GAP-09: an estimate may never be presented as a measurement.
    const estimated: TelemetryPosture['usageSource'] = 'estimated'
    const reported: TelemetryPosture['usageSource'] = 'provider-telemetry'

    expect(estimated).not.toBe(reported)
  })
})

describe('lifecycle contracts (doc 07)', () => {
  it('records a self-updater command so its use can be forbidden', () => {
    // The field exists to detect ownership drift, not to invoke the updater.
    const plan: AdapterLifecyclePlan = {
      planId: 'plan-01',
      ref,
      action: 'update',
      recipeId: 'recipe-claude-linux',
      fromVersion: '2.0.0',
      toVersion: '2.1.0',
      phases: ['requested', 'locked', 'staged', 'activated', 'committed'],
      requiresMigration: false,
      requiresApproval: true,
      createdAt: '2026-08-08T12:00:00.000Z',
    }

    expect(plan.fromVersion).toBe('2.0.0')
    expect(plan.requiresApproval).toBe(true)
  })

  it('represents a fresh install as a null fromVersion', () => {
    const install: AdapterLifecyclePlan['fromVersion'] = null

    expect(install).toBeNull()
  })

  it('classifies upstream drift beyond a plain version bump', () => {
    // 'new-version' is promotable; a contract change is not.
    const benign: UpstreamDrift = 'new-version'
    const breaking: UpstreamDrift = 'config-schema-changed'

    expect(benign).not.toBe(breaking)

    // @ts-expect-error 'minor' is not a drift classification
    const invalid: UpstreamDrift = 'minor'
    void invalid
  })

  it('rejects a lifecycle action outside the enrolled-authority set', () => {
    // @ts-expect-error 'delete-home' is not a lifecycle action
    const invalid: AdapterLifecyclePlan['action'] = 'delete-home'
    void invalid
  })
})
