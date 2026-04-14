/**
 * Tests for ECO-177 (Plugin Marketplace) and ECO-181 (Incident Response).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  searchMarketplace,
  filterByCategory,
  formatPluginTable,
  createSampleRegistry,
} from '../cli/marketplace-command.js'
import type { MarketplaceRegistry } from '../cli/marketplace-command.js'
import {
  IncidentResponseEngine,
  clearIncidentFlags,
  isAgentKilled,
  isToolDisabled,
  isNamespaceQuarantined,
} from '../security/incident-response.js'
import type {
  IncidentPlaybook,
  IncidentResponseConfig,
} from '../security/incident-response.js'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'

// ===========================================================================
// ECO-177: Plugin Marketplace
// ===========================================================================

describe('Plugin Marketplace', () => {
  let registry: MarketplaceRegistry

  beforeEach(() => {
    registry = createSampleRegistry()
  })

  it('createSampleRegistry has 10+ plugins', () => {
    expect(registry.plugins.length).toBeGreaterThanOrEqual(10)
    expect(registry.categories.length).toBeGreaterThanOrEqual(6)
    expect(registry.lastUpdated).toBeTruthy()
  })

  it('searchMarketplace by name', () => {
    const results = searchMarketplace(registry, 'otel')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.name).toContain('otel')
  })

  it('searchMarketplace by description', () => {
    const results = searchMarketplace(registry, 'Prometheus')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.description.toLowerCase()).toContain('prometheus')
  })

  it('searchMarketplace by tag', () => {
    const results = searchMarketplace(registry, 'embeddings')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some((p) => p.tags.includes('embeddings'))).toBe(true)
  })

  it('searchMarketplace returns empty for no match', () => {
    const results = searchMarketplace(registry, 'xyznonexistent')
    expect(results.length).toBe(0)
  })

  it('filterByCategory returns correct plugins', () => {
    const observability = filterByCategory(registry, 'observability')
    expect(observability.length).toBeGreaterThanOrEqual(1)
    for (const plugin of observability) {
      expect(plugin.category).toBe('observability')
    }
  })

  it('filterByCategory is case-insensitive', () => {
    const security = filterByCategory(registry, 'SECURITY')
    expect(security.length).toBeGreaterThanOrEqual(1)
    for (const plugin of security) {
      expect(plugin.category).toBe('security')
    }
  })

  it('filterByCategory returns empty for unknown category', () => {
    const results = filterByCategory(registry, 'nonexistent')
    expect(results.length).toBe(0)
  })

  it('formatPluginTable produces formatted string', () => {
    const plugins = registry.plugins.slice(0, 3)
    const table = formatPluginTable(plugins)
    expect(typeof table).toBe('string')
    expect(table).toContain('Name')
    expect(table).toContain('Version')
    expect(table).toContain('Category')
    expect(table).toContain('Author')
    // Contains separator line
    expect(table).toContain('-+-')
    // Contains at least one plugin name
    expect(table).toContain(plugins[0]!.name)
  })

  it('formatPluginTable shows verified badge', () => {
    const verified = registry.plugins.filter((p) => p.verified)
    const unverified = registry.plugins.filter((p) => !p.verified)
    expect(verified.length).toBeGreaterThanOrEqual(1)
    expect(unverified.length).toBeGreaterThanOrEqual(1)

    const table = formatPluginTable([verified[0]!, unverified[0]!])
    expect(table).toContain('[v]')
    expect(table).toContain('[ ]')
  })

  it('formatPluginTable handles empty list', () => {
    const table = formatPluginTable([])
    expect(table).toBe('No plugins found.')
  })
})

// ===========================================================================
// ECO-181: Incident Response
// ===========================================================================

describe('IncidentResponseEngine', () => {
  let eventBus: DzupEventBus
  let engine: IncidentResponseEngine

  function makePlaybook(overrides?: Partial<IncidentPlaybook>): IncidentPlaybook {
    return {
      id: 'pb-1',
      name: 'Test Playbook',
      description: 'A test playbook',
      triggers: [
        { eventType: 'safety:violation', severity: 'critical' },
      ],
      actions: [
        { type: 'log_alert', config: { message: 'Safety violation detected' } },
      ],
      enabled: true,
      ...overrides,
    }
  }

  beforeEach(() => {
    clearIncidentFlags()
    eventBus = createEventBus()
  })

  afterEach(() => {
    engine?.dispose()
    clearIncidentFlags()
  })

  it('attach/detach lifecycle', () => {
    const config: IncidentResponseConfig = { playbooks: [makePlaybook()] }
    engine = new IncidentResponseEngine(config)

    // Should not throw
    engine.attach(eventBus)
    engine.detach()
    // Double detach should be safe
    engine.detach()
  })

  it('executePlaybook runs all actions', async () => {
    const playbook = makePlaybook({
      actions: [
        { type: 'log_alert', config: { message: 'Alert 1' } },
        { type: 'kill_agent', config: { agentId: 'agent-x' } },
      ],
    })
    const config: IncidentResponseConfig = { playbooks: [playbook] }
    engine = new IncidentResponseEngine(config)

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const record = await engine.executePlaybook(playbook, { type: 'safety:violation' })
    consoleSpy.mockRestore()

    expect(record.actionsTaken.length).toBe(2)
    expect(record.actionsTaken[0]!.action).toBe('log_alert')
    expect(record.actionsTaken[0]!.success).toBe(true)
    expect(record.actionsTaken[1]!.action).toBe('kill_agent')
    expect(record.actionsTaken[1]!.success).toBe(true)
  })

  it('executePlaybook records incident', async () => {
    const playbook = makePlaybook()
    const config: IncidentResponseConfig = { playbooks: [playbook] }
    engine = new IncidentResponseEngine(config)

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await engine.executePlaybook(playbook, { type: 'safety:violation' })
    consoleSpy.mockRestore()

    const incidents = engine.getIncidents()
    expect(incidents.length).toBe(1)
    expect(incidents[0]!.playbookId).toBe('pb-1')
    expect(incidents[0]!.triggeredBy).toBe('safety:violation')
    expect(incidents[0]!.severity).toBe('critical')
    expect(incidents[0]!.resolved).toBe(false)
  })

  it('kill_agent action sets flag', async () => {
    const playbook = makePlaybook({
      actions: [{ type: 'kill_agent', config: { agentId: 'agent-99' } }],
    })
    const config: IncidentResponseConfig = { playbooks: [playbook] }
    engine = new IncidentResponseEngine(config)

    expect(isAgentKilled('agent-99')).toBe(false)
    await engine.executePlaybook(playbook, { type: 'safety:violation' })
    expect(isAgentKilled('agent-99')).toBe(true)
  })

  it('disable_tool action adds to set', async () => {
    const playbook = makePlaybook({
      actions: [{ type: 'disable_tool', config: { toolName: 'exec_shell' } }],
    })
    const config: IncidentResponseConfig = { playbooks: [playbook] }
    engine = new IncidentResponseEngine(config)

    expect(isToolDisabled('exec_shell')).toBe(false)
    await engine.executePlaybook(playbook, { type: 'safety:violation' })
    expect(isToolDisabled('exec_shell')).toBe(true)
  })

  it('quarantine_namespace marks namespace', async () => {
    const playbook = makePlaybook({
      actions: [{ type: 'quarantine_namespace', config: { namespace: 'secrets' } }],
    })
    const config: IncidentResponseConfig = { playbooks: [playbook] }
    engine = new IncidentResponseEngine(config)

    expect(isNamespaceQuarantined('secrets')).toBe(false)
    await engine.executePlaybook(playbook, { type: 'safety:violation' })
    expect(isNamespaceQuarantined('secrets')).toBe(true)
  })

  it('log_alert action logs warning', async () => {
    const playbook = makePlaybook({
      actions: [{ type: 'log_alert', config: { message: 'Test alert message' } }],
    })
    const config: IncidentResponseConfig = { playbooks: [playbook] }
    engine = new IncidentResponseEngine(config)

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await engine.executePlaybook(playbook, { type: 'safety:violation' })
    expect(consoleSpy).toHaveBeenCalledTimes(1)
    expect(consoleSpy.mock.calls[0]![0]).toContain('Test alert message')
    consoleSpy.mockRestore()
  })

  it('webhook_notification sends POST (mock fetch)', async () => {
    const playbook = makePlaybook({
      actions: [{ type: 'webhook_notification', config: { url: 'https://hooks.example.com/alert' } }],
    })
    const config: IncidentResponseConfig = { playbooks: [playbook] }
    engine = new IncidentResponseEngine(config)

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    engine.setFetchImpl(mockFetch)

    const record = await engine.executePlaybook(playbook, { type: 'safety:violation' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://hooks.example.com/alert')
    expect(init.method).toBe('POST')
    expect(record.actionsTaken[0]!.success).toBe(true)
  })

  it('cooldown: second trigger within cooldown is skipped', async () => {
    const onIncident = vi.fn()
    const playbook = makePlaybook({ cooldownMs: 60_000 })
    const config: IncidentResponseConfig = { playbooks: [playbook], onIncident }
    engine = new IncidentResponseEngine(config)

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    engine.attach(eventBus)

    // First event should trigger
    eventBus.emit({
      type: 'safety:violation',
      category: 'injection',
      severity: 'critical',
      message: 'First',
    })

    // Allow microtask to process
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onIncident).toHaveBeenCalledTimes(1)

    // Second event within cooldown should be skipped
    eventBus.emit({
      type: 'safety:violation',
      category: 'injection',
      severity: 'critical',
      message: 'Second',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onIncident).toHaveBeenCalledTimes(1) // Still 1, not 2

    consoleSpy.mockRestore()
  })

  it('getIncidents returns history', async () => {
    const playbook = makePlaybook()
    const config: IncidentResponseConfig = { playbooks: [playbook] }
    engine = new IncidentResponseEngine(config)

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await engine.executePlaybook(playbook, { type: 'safety:violation' })
    await engine.executePlaybook(playbook, { type: 'safety:violation' })
    consoleSpy.mockRestore()

    const incidents = engine.getIncidents()
    expect(incidents.length).toBe(2)
    // Returned array should be a copy
    incidents.pop()
    expect(engine.getIncidents().length).toBe(2)
  })

  it('resolveIncident marks resolved', async () => {
    const playbook = makePlaybook()
    const config: IncidentResponseConfig = { playbooks: [playbook] }
    engine = new IncidentResponseEngine(config)

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const record = await engine.executePlaybook(playbook, { type: 'safety:violation' })
    consoleSpy.mockRestore()

    expect(record.resolved).toBe(false)
    engine.resolveIncident(record.id)

    const incidents = engine.getIncidents()
    const resolved = incidents.find((i) => i.id === record.id)
    expect(resolved!.resolved).toBe(true)
    expect(resolved!.resolvedAt).toBeInstanceOf(Date)
  })

  it('addPlaybook at runtime', async () => {
    const config: IncidentResponseConfig = { playbooks: [] }
    engine = new IncidentResponseEngine(config)

    const onIncident = vi.fn()
    const newPlaybook = makePlaybook({ id: 'pb-dynamic' })
    engine.addPlaybook(newPlaybook)

    // Manually execute to verify it's there
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const record = await engine.executePlaybook(newPlaybook, { type: 'safety:violation' })
    consoleSpy.mockRestore()

    expect(record.playbookId).toBe('pb-dynamic')
    // Verify via onIncident callback approach won't work here since we
    // didn't pass it, but the record is in history
    expect(engine.getIncidents().length).toBe(1)
    // Suppress unused var
    void onIncident
  })

  it('removePlaybook at runtime', async () => {
    const onIncident = vi.fn()
    const playbook = makePlaybook({ cooldownMs: 0 })
    const config: IncidentResponseConfig = { playbooks: [playbook], onIncident }
    engine = new IncidentResponseEngine(config)

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    engine.attach(eventBus)

    // Remove the playbook
    engine.removePlaybook('pb-1')

    // Emit event — should NOT trigger since playbook was removed
    eventBus.emit({
      type: 'safety:violation',
      category: 'injection',
      severity: 'critical',
      message: 'test',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onIncident).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('event matching: correct playbook triggered for event type', async () => {
    const onIncident = vi.fn()
    const safetyPlaybook = makePlaybook({
      id: 'pb-safety',
      triggers: [{ eventType: 'safety:violation', severity: 'critical' }],
      cooldownMs: 0,
    })
    const memoryPlaybook = makePlaybook({
      id: 'pb-memory',
      triggers: [{ eventType: 'memory:threat_detected', severity: 'high' }],
      actions: [{ type: 'log_alert', config: { message: 'Memory threat' } }],
      cooldownMs: 0,
    })
    const config: IncidentResponseConfig = {
      playbooks: [safetyPlaybook, memoryPlaybook],
      onIncident,
    }
    engine = new IncidentResponseEngine(config)

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    engine.attach(eventBus)

    // Emit memory threat — should trigger pb-memory, not pb-safety
    eventBus.emit({
      type: 'memory:threat_detected',
      threatType: 'injection',
      namespace: 'secrets',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onIncident).toHaveBeenCalledTimes(1)
    expect(onIncident.mock.calls[0]![0].playbookId).toBe('pb-memory')

    consoleSpy.mockRestore()
  })

  it('condition filter: only triggers when condition returns true', async () => {
    const onIncident = vi.fn()
    const playbook = makePlaybook({
      triggers: [
        {
          eventType: 'safety:violation',
          severity: 'critical',
          condition: (event) => event['category'] === 'prompt_injection',
        },
      ],
      cooldownMs: 0,
    })
    const config: IncidentResponseConfig = { playbooks: [playbook], onIncident }
    engine = new IncidentResponseEngine(config)

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    engine.attach(eventBus)

    // Emit event that does NOT match condition
    eventBus.emit({
      type: 'safety:violation',
      category: 'rate_limit',
      severity: 'low',
      message: 'rate limited',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onIncident).not.toHaveBeenCalled()

    // Emit event that DOES match condition
    eventBus.emit({
      type: 'safety:violation',
      category: 'prompt_injection',
      severity: 'critical',
      message: 'injection detected',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onIncident).toHaveBeenCalledTimes(1)

    consoleSpy.mockRestore()
  })

  it('dispose cleans up subscriptions', () => {
    const config: IncidentResponseConfig = { playbooks: [makePlaybook()] }
    engine = new IncidentResponseEngine(config)
    engine.attach(eventBus)
    engine.dispose()
    // Double dispose should be safe
    engine.dispose()
  })
})
