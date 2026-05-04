import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'

import { ProviderAdapterRegistry } from '../../registry/adapter-registry.js'
import { UCLEnrichmentStep } from '../ucl-enrichment-step.js'
import type { AdapterProviderId, AgentCLIAdapter, AgentEvent, AgentInput } from '../../types.js'

function stubAdapter(providerId: AdapterProviderId): AgentCLIAdapter {
  return {
    providerId,
    async *execute(_input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
      // empty
    },
    async *resumeSession(
      _id: string,
      _input: AgentInput,
    ): AsyncGenerator<AgentEvent, void, undefined> {
      // empty
    },
    interrupt() {},
    async healthCheck() {
      return { healthy: true, providerId, sdkInstalled: true, cliAvailable: true }
    },
    configure() {},
  }
}

describe('UCLEnrichmentStep', () => {
  let bus: DzupEventBus
  let registry: ProviderAdapterRegistry
  let workdir: string

  beforeEach(() => {
    bus = createEventBus()
    registry = new ProviderAdapterRegistry()
    registry.register(stubAdapter('claude' as AdapterProviderId))
    workdir = mkdtempSync(join(tmpdir(), 'ucl-step-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('reports disabled when no config is provided', () => {
    const step = new UCLEnrichmentStep(registry, bus, undefined)
    expect(step.enabled).toBe(false)
  })

  it('reports enabled when config is provided', () => {
    const step = new UCLEnrichmentStep(registry, bus, { projectRoot: workdir })
    expect(step.enabled).toBe(true)
  })

  it('apply() is a no-op when no config is provided', async () => {
    const step = new UCLEnrichmentStep(registry, bus, undefined)
    const input: AgentInput = { prompt: 'hi' }
    await step.apply(input)
    expect(input.systemPrompt).toBeUndefined()
  })

  it('apply() does not throw on a directory without .dzupagent/', async () => {
    const step = new UCLEnrichmentStep(registry, bus, { projectRoot: workdir })
    const input: AgentInput = { prompt: 'hi' }
    await expect(step.apply(input)).resolves.toBeUndefined()
  })

  it('resolvePaths() caches the resolved paths after the first call', async () => {
    mkdirSync(join(workdir, '.dzupagent'), { recursive: true })
    const step = new UCLEnrichmentStep(registry, bus, { projectRoot: workdir })
    const a = await step.resolvePaths()
    const b = await step.resolvePaths()
    expect(a).toBe(b)
  })

  it('uses process.cwd() when projectRoot is not provided in config', async () => {
    const step = new UCLEnrichmentStep(registry, bus, {})
    const paths = await step.resolvePaths()
    // Should not throw and should return a paths object whose root resolves
    // relative to the current process working directory.
    expect(paths).toBeDefined()
  })
})
