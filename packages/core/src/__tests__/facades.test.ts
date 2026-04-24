import { describe, it, expect, beforeAll } from 'vitest'

// ---------------------------------------------------------------------------
// Validate that each facade re-exports the expected symbols without pulling
// in the full index.ts surface. These are structural smoke tests — they
// confirm that the module graph resolves and key symbols are available.
//
// NOTE: The `memory` facade was removed in MC-A01 (core -> memory layer
// inversion fix). Memory symbols must be imported from @dzupagent/memory.
// ---------------------------------------------------------------------------

const quickStartModulePromise = import('../facades/quick-start.js')
const orchestrationModulePromise = import('../facades/orchestration.js')
const securityModulePromise = import('../facades/security.js')
const facadesIndexModulePromise = import('../facades/index.js')
const stableModulePromise = import('../stable.js')
const advancedModulePromise = import('../advanced.js')
const rootModulePromise = import('../index.js')

describe('facades/quick-start', () => {
  let mod: Awaited<typeof quickStartModulePromise>

  beforeAll(async () => {
    mod = await quickStartModulePromise
  })

  it('exports createQuickAgent helper', async () => {
    expect(typeof mod.createQuickAgent).toBe('function')
  }, 15_000)

  it('exports core building blocks', async () => {
    expect(typeof mod.createContainer).toBe('function')
    expect(typeof mod.createEventBus).toBe('function')
    expect(typeof mod.ModelRegistry).toBe('function')
    expect(typeof mod.ForgeError).toBe('function')
    expect(typeof mod.invokeWithTimeout).toBe('function')
    expect(typeof mod.SSETransformer).toBe('function')
  })

  it('exports config helpers', async () => {
    expect(mod.DEFAULT_CONFIG).toBeDefined()
    expect(typeof mod.resolveConfig).toBe('function')
    expect(typeof mod.mergeConfigs).toBe('function')
  })

  it('createQuickAgent wires container correctly', async () => {
    const result = mod.createQuickAgent({
      provider: 'anthropic',
      apiKey: 'test-key',
    })

    expect(result.container).toBeDefined()
    expect(result.eventBus).toBeDefined()
    expect(result.registry).toBeDefined()

    // Container should have the services registered
    expect(result.container.has('eventBus')).toBe(true)
    expect(result.container.has('registry')).toBe(true)

    // Container.get should return the same instances
    expect(result.container.get('eventBus')).toBe(result.eventBus)
    expect(result.container.get('registry')).toBe(result.registry)
  })

  it('createQuickAgent applies custom model names', async () => {
    const result = mod.createQuickAgent({
      provider: 'openai',
      apiKey: 'test-key',
      chatModel: 'gpt-4-turbo',
      codegenModel: 'gpt-4',
      chatMaxTokens: 2048,
      codegenMaxTokens: 4096,
    })

    // Registry should be populated (no throw on getModel)
    expect(result.registry).toBeDefined()
  })
})

describe('facades/orchestration', () => {
  let mod: Awaited<typeof orchestrationModulePromise>

  beforeAll(async () => {
    mod = await orchestrationModulePromise
  })

  it('exports event bus and agent bus', async () => {
    expect(typeof mod.createEventBus).toBe('function')
    expect(typeof mod.AgentBus).toBe('function')
  })

  it('exports routing', async () => {
    expect(typeof mod.IntentRouter).toBe('function')
    expect(typeof mod.KeywordMatcher).toBe('function')
    expect(typeof mod.CostAwareRouter).toBe('function')
    expect(typeof mod.ModelTierEscalationPolicy).toBe('function')
  })

  it('exports pipeline schemas', async () => {
    expect(mod.PipelineDefinitionSchema).toBeDefined()
    expect(typeof mod.serializePipeline).toBe('function')
    expect(typeof mod.deserializePipeline).toBe('function')
    expect(typeof mod.autoLayout).toBe('function')
  })

  it('exports sub-agent and skill management', async () => {
    expect(typeof mod.SubAgentSpawner).toBe('function')
    expect(typeof mod.SkillLoader).toBe('function')
    expect(typeof mod.SkillManager).toBe('function')
    expect(typeof mod.SkillLearner).toBe('function')
    expect(typeof mod.parseAgentsMd).toBe('function')
  })

  it('exports protocol messaging', async () => {
    expect(typeof mod.createForgeMessage).toBe('function')
    expect(typeof mod.createResponse).toBe('function')
    expect(typeof mod.ProtocolRouter).toBe('function')
    expect(typeof mod.ProtocolBridge).toBe('function')
  })

  it('exports persistence stores', async () => {
    expect(typeof mod.InMemoryRunStore).toBe('function')
    expect(typeof mod.InMemoryAgentStore).toBe('function')
    expect(typeof mod.InMemoryEventLog).toBe('function')
  })

  it('exports concurrency and observability', async () => {
    expect(typeof mod.Semaphore).toBe('function')
    expect(typeof mod.ConcurrencyPool).toBe('function')
    expect(typeof mod.MetricsCollector).toBe('function')
    expect(typeof mod.HealthAggregator).toBe('function')
  })
})

describe('facades/security', () => {
  let mod: Awaited<typeof securityModulePromise>

  beforeAll(async () => {
    mod = await securityModulePromise
  })

  it('exports risk classification', async () => {
    expect(typeof mod.createRiskClassifier).toBe('function')
  })

  it('exports secrets scanning and PII detection', async () => {
    expect(typeof mod.scanForSecrets).toBe('function')
    expect(typeof mod.redactSecrets).toBe('function')
    expect(typeof mod.detectPII).toBe('function')
    expect(typeof mod.redactPII).toBe('function')
  })

  it('exports output pipeline', async () => {
    expect(typeof mod.OutputPipeline).toBe('function')
    expect(typeof mod.createDefaultPipeline).toBe('function')
  })

  it('exports policy engine', async () => {
    expect(typeof mod.PolicyEvaluator).toBe('function')
    expect(typeof mod.InMemoryPolicyStore).toBe('function')
    expect(typeof mod.PolicyTranslator).toBe('function')
  })

  it('exports audit trail', async () => {
    expect(typeof mod.ComplianceAuditLogger).toBe('function')
    expect(typeof mod.InMemoryAuditStore).toBe('function')
  })

  it('exports safety monitor', async () => {
    expect(typeof mod.createSafetyMonitor).toBe('function')
    expect(typeof mod.getBuiltInRules).toBe('function')
  })

  it('exports memory defense', async () => {
    expect(typeof mod.createMemoryDefense).toBe('function')
  })

  it('exports data classification', async () => {
    expect(typeof mod.DataClassifier).toBe('function')
    expect(mod.DEFAULT_CLASSIFICATION_PATTERNS).toBeDefined()
  })

  it('exports tool permission defaults', async () => {
    expect(Array.isArray(mod.DEFAULT_AUTO_APPROVE_TOOLS)).toBe(true)
    expect(Array.isArray(mod.DEFAULT_LOG_TOOLS)).toBe(true)
    expect(Array.isArray(mod.DEFAULT_REQUIRE_APPROVAL_TOOLS)).toBe(true)
  })
})

describe('facades/index (namespace re-exports)', () => {
  let mod: Awaited<typeof facadesIndexModulePromise>

  beforeAll(async () => {
    mod = await facadesIndexModulePromise
  })

  it('exports quickStart, orchestration, security namespaces', async () => {
    expect(mod.quickStart).toBeDefined()
    expect(mod.orchestration).toBeDefined()
    expect(mod.security).toBeDefined()
    // memory namespace removed in MC-A01; import from @dzupagent/memory directly
    expect((mod as Record<string, unknown>).memory).toBeUndefined()
  })

  it('namespaces contain expected symbols', async () => {
    expect(typeof mod.quickStart.createQuickAgent).toBe('function')
    expect(typeof mod.orchestration.IntentRouter).toBe('function')
    expect(typeof mod.security.PolicyEvaluator).toBe('function')
  })
})

describe('stable entrypoint', () => {
  let mod: Awaited<typeof stableModulePromise>

  beforeAll(async () => {
    mod = await stableModulePromise
  })

  it('exports the curated facade namespaces', async () => {
    expect(mod.quickStart).toBeDefined()
    expect(mod.orchestration).toBeDefined()
    expect(mod.security).toBeDefined()
    // memory namespace removed in MC-A01
    expect((mod as Record<string, unknown>).memory).toBeUndefined()
  })

  it('keeps access through the facade namespaces', async () => {
    expect(typeof mod.quickStart.createQuickAgent).toBe('function')
    expect(typeof mod.orchestration.IntentRouter).toBe('function')
    expect(typeof mod.security.PolicyEvaluator).toBe('function')
  })
})

describe('advanced entrypoint', () => {
  let mod: Awaited<typeof advancedModulePromise>
  let root: Awaited<typeof rootModulePromise>

  beforeAll(async () => {
    ;[mod, root] = await Promise.all([advancedModulePromise, rootModulePromise])
  })

  it('re-exports representative root symbols', async () => {
    expect(typeof mod.createContainer).toBe('function')
    expect(typeof mod.createEventBus).toBe('function')
    expect(typeof mod.ModelRegistry).toBe('function')
    expect(typeof mod.IntentRouter).toBe('function')
    expect(typeof mod.createRiskClassifier).toBe('function')
  })

  it('tracks the current root entrypoint for compatibility', async () => {
    expect(mod.createContainer).toBe(root.createContainer)
    expect(mod.createEventBus).toBe(root.createEventBus)
    expect(mod.ModelRegistry).toBe(root.ModelRegistry)
  })
})
