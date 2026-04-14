import { describe, it, expect, beforeEach } from 'vitest'

import type { AdapterSkillBundle } from '../skills/adapter-skill-types.js'
import { AdapterSkillRegistry, createDefaultSkillRegistry } from '../skills/adapter-skill-registry.js'
import { InMemoryAdapterSkillVersionStore } from '../skills/adapter-skill-version-store.js'
import { InMemoryAdapterSkillTelemetry } from '../skills/adapter-skill-telemetry.js'
import type { ProjectionTelemetryRecord } from '../skills/adapter-skill-telemetry.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBundle(overrides: Partial<AdapterSkillBundle> = {}): AdapterSkillBundle {
  return {
    bundleId: 'bundle-001',
    skillSetId: 'skillset-alpha',
    skillSetVersion: '2.1.0',
    personaId: 'code-reviewer',
    constraints: {
      maxBudgetUsd: 5,
      approvalMode: 'conditional',
      networkPolicy: 'restricted',
      toolPolicy: 'balanced',
    },
    promptSections: [
      { id: 'safety', purpose: 'safety', content: 'Never execute destructive commands.', priority: 1 },
      { id: 'task', purpose: 'task', content: 'Review the pull request for correctness.', priority: 10 },
    ],
    toolBindings: [
      { toolName: 'read_file', mode: 'required' },
      { toolName: 'exec_command', mode: 'blocked' },
    ],
    metadata: {
      owner: 'platform-team',
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Version Store
// ---------------------------------------------------------------------------

describe('InMemoryAdapterSkillVersionStore', () => {
  let store: InMemoryAdapterSkillVersionStore
  let registry: AdapterSkillRegistry

  beforeEach(() => {
    store = new InMemoryAdapterSkillVersionStore()
    registry = createDefaultSkillRegistry()
  })

  it('auto-increments version on compileAndStore', () => {
    const bundle = makeBundle()
    const v1 = registry.compileAndStore(bundle, 'claude', store)
    expect(v1.version).toBe(1)
    expect(v1.projectionId).toBe('bundle-001-claude-v1')

    const v2 = registry.compileAndStore(
      makeBundle({ skillSetVersion: '2.2.0' }),
      'claude',
      store,
    )
    expect(v2.version).toBe(2)
    expect(v2.projectionId).toBe('bundle-001-claude-v2')
  })

  it('marks previous version as superseded', () => {
    const bundle = makeBundle()
    registry.compileAndStore(bundle, 'codex', store)
    registry.compileAndStore(makeBundle({ skillSetVersion: '3.0.0' }), 'codex', store)

    const v1 = store.getVersion('bundle-001', 'codex', 1)
    expect(v1?.supersededAt).toBeDefined()
    expect(v1?.supersededBy).toBe('v2')
  })

  it('getLatest returns the most recent version', () => {
    const bundle = makeBundle()
    registry.compileAndStore(bundle, 'claude', store)
    registry.compileAndStore(makeBundle({ skillSetVersion: '3.0.0' }), 'claude', store)

    const latest = store.getLatest('bundle-001', 'claude')
    expect(latest?.version).toBe(2)
  })

  it('getVersion returns specific version', () => {
    registry.compileAndStore(makeBundle(), 'claude', store)
    registry.compileAndStore(makeBundle({ skillSetVersion: '3.0.0' }), 'claude', store)

    const v1 = store.getVersion('bundle-001', 'claude', 1)
    expect(v1).toBeDefined()
    expect(v1?.version).toBe(1)
  })

  it('getVersion returns undefined for non-existent version', () => {
    registry.compileAndStore(makeBundle(), 'claude', store)
    expect(store.getVersion('bundle-001', 'claude', 99)).toBeUndefined()
  })

  it('listVersions returns all versions in order', () => {
    registry.compileAndStore(makeBundle(), 'claude', store)
    registry.compileAndStore(makeBundle({ skillSetVersion: '3.0.0' }), 'claude', store)
    registry.compileAndStore(makeBundle({ skillSetVersion: '4.0.0' }), 'claude', store)

    const versions = store.listVersions('bundle-001', 'claude')
    expect(versions).toHaveLength(3)
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3])
  })

  it('listVersions returns empty array for unknown bundle', () => {
    expect(store.listVersions('nonexistent', 'claude')).toEqual([])
  })

  it('getLatest returns undefined for unknown bundle', () => {
    expect(store.getLatest('nonexistent', 'claude')).toBeUndefined()
  })

  it('stores independently per providerId', () => {
    registry.compileAndStore(makeBundle(), 'claude', store)
    registry.compileAndStore(makeBundle(), 'codex', store)

    expect(store.getLatest('bundle-001', 'claude')?.version).toBe(1)
    expect(store.getLatest('bundle-001', 'codex')?.version).toBe(1)
    expect(store.listVersions('bundle-001', 'claude')).toHaveLength(1)
    expect(store.listVersions('bundle-001', 'codex')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe('rollback', () => {
  let store: InMemoryAdapterSkillVersionStore
  let registry: AdapterSkillRegistry

  beforeEach(() => {
    store = new InMemoryAdapterSkillVersionStore()
    registry = createDefaultSkillRegistry()
  })

  it('rollback to previous version creates a new version entry', () => {
    registry.compileAndStore(makeBundle(), 'claude', store)
    registry.compileAndStore(makeBundle({ skillSetVersion: '3.0.0' }), 'claude', store)

    const rolled = registry.rollback('bundle-001', 'claude', 1, store)
    expect(rolled.version).toBe(3)
    // The rolled version should contain the same compiled output as v1
    const v1 = store.getVersion('bundle-001', 'claude', 1)
    expect(rolled.hash).toBe(v1?.hash)
    expect(rolled.compiled).toEqual(v1?.compiled)
  })

  it('rollback marks previous latest as superseded', () => {
    registry.compileAndStore(makeBundle(), 'claude', store)
    registry.compileAndStore(makeBundle({ skillSetVersion: '3.0.0' }), 'claude', store)

    registry.rollback('bundle-001', 'claude', 1, store)

    const v2 = store.getVersion('bundle-001', 'claude', 2)
    expect(v2?.supersededAt).toBeDefined()
    expect(v2?.supersededBy).toBe('v3')
  })

  it('rollback to non-existent version throws', () => {
    registry.compileAndStore(makeBundle(), 'claude', store)

    expect(() => registry.rollback('bundle-001', 'claude', 99, store)).toThrow(
      /Version 99 not found/,
    )
  })

  it('rollback to non-existent bundle throws', () => {
    expect(() => registry.rollback('nonexistent', 'claude', 1, store)).toThrow(
      /Version 1 not found/,
    )
  })

  it('multiple rollbacks produce incrementing versions', () => {
    registry.compileAndStore(makeBundle(), 'claude', store)
    registry.compileAndStore(makeBundle({ skillSetVersion: '3.0.0' }), 'claude', store)

    const r1 = registry.rollback('bundle-001', 'claude', 1, store)
    expect(r1.version).toBe(3)

    const r2 = registry.rollback('bundle-001', 'claude', 2, store)
    expect(r2.version).toBe(4)

    expect(store.listVersions('bundle-001', 'claude')).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

describe('InMemoryAdapterSkillTelemetry', () => {
  let telemetry: InMemoryAdapterSkillTelemetry

  beforeEach(() => {
    telemetry = new InMemoryAdapterSkillTelemetry()
  })

  function makeTelemetryRecord(
    overrides: Partial<ProjectionTelemetryRecord> = {},
  ): ProjectionTelemetryRecord {
    return {
      runId: 'run-001',
      bundleId: 'bundle-001',
      providerId: 'claude',
      projectionHash: 'abc123',
      projectionVersion: 1,
      success: true,
      timestamp: '2026-04-01T00:00:00Z',
      ...overrides,
    }
  }

  it('records and retrieves telemetry entries', () => {
    telemetry.record(makeTelemetryRecord())
    telemetry.record(makeTelemetryRecord({ runId: 'run-002' }))

    const history = telemetry.getHistory('bundle-001', 'claude')
    expect(history).toHaveLength(2)
  })

  it('computes usage stats correctly', () => {
    telemetry.record(makeTelemetryRecord({ success: true, latencyMs: 100 }))
    telemetry.record(makeTelemetryRecord({ success: true, latencyMs: 200, runId: 'run-002' }))
    telemetry.record(
      makeTelemetryRecord({
        success: false,
        latencyMs: 300,
        runId: 'run-003',
        errorMessage: 'timeout',
      }),
    )

    const stats = telemetry.getUsageStats('bundle-001', 'claude')
    expect(stats.totalUses).toBe(3)
    expect(stats.successRate).toBeCloseTo(2 / 3)
    expect(stats.avgLatencyMs).toBe(200)
    expect(stats.lastUsed).toBe('2026-04-01T00:00:00Z')
    expect(stats.currentVersion).toBe(1)
  })

  it('returns zero stats for unknown bundle', () => {
    const stats = telemetry.getUsageStats('nonexistent', 'claude')
    expect(stats.totalUses).toBe(0)
    expect(stats.successRate).toBe(0)
    expect(stats.avgLatencyMs).toBeUndefined()
    expect(stats.lastUsed).toBeUndefined()
    expect(stats.currentVersion).toBeUndefined()
  })

  it('avgLatencyMs is undefined when no entries have latency', () => {
    telemetry.record(makeTelemetryRecord({ latencyMs: undefined }))
    const stats = telemetry.getUsageStats('bundle-001', 'claude')
    expect(stats.avgLatencyMs).toBeUndefined()
  })

  it('getHistory respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      telemetry.record(
        makeTelemetryRecord({
          runId: `run-${i}`,
          timestamp: `2026-04-01T00:0${i}:00Z`,
        }),
      )
    }

    const limited = telemetry.getHistory('bundle-001', 'claude', 3)
    expect(limited).toHaveLength(3)
    // Should be the 3 most recent
    expect(limited[0].runId).toBe('run-7')
    expect(limited[2].runId).toBe('run-9')
  })

  it('getHistory returns all entries when limit is omitted', () => {
    for (let i = 0; i < 5; i++) {
      telemetry.record(makeTelemetryRecord({ runId: `run-${i}` }))
    }
    expect(telemetry.getHistory('bundle-001', 'claude')).toHaveLength(5)
  })

  it('getHistory returns empty array for unknown bundle', () => {
    expect(telemetry.getHistory('nonexistent', 'claude')).toEqual([])
  })

  it('tracks rollback entries via rollbackFrom field', () => {
    telemetry.record(makeTelemetryRecord({ projectionVersion: 1 }))
    telemetry.record(
      makeTelemetryRecord({
        runId: 'run-rollback',
        projectionVersion: 3,
        rollbackFrom: 2,
      }),
    )

    const history = telemetry.getHistory('bundle-001', 'claude')
    const rollbackEntry = history.find((e) => e.rollbackFrom !== undefined)
    expect(rollbackEntry).toBeDefined()
    expect(rollbackEntry?.rollbackFrom).toBe(2)
    expect(rollbackEntry?.projectionVersion).toBe(3)
  })

  it('tracks per provider independently', () => {
    telemetry.record(makeTelemetryRecord({ providerId: 'claude' }))
    telemetry.record(makeTelemetryRecord({ providerId: 'codex' }))

    expect(telemetry.getUsageStats('bundle-001', 'claude').totalUses).toBe(1)
    expect(telemetry.getUsageStats('bundle-001', 'codex').totalUses).toBe(1)
  })
})
