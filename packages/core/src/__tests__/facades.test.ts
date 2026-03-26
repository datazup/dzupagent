import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Validate that each facade re-exports the expected symbols without pulling
// in the full index.ts surface. These are structural smoke tests — they
// confirm that the module graph resolves and key symbols are available.
// ---------------------------------------------------------------------------

describe('facades/quick-start', () => {
  it('exports createQuickAgent helper', async () => {
    const mod = await import('../facades/quick-start.js')
    expect(typeof mod.createQuickAgent).toBe('function')
  })

  it('exports core building blocks', async () => {
    const mod = await import('../facades/quick-start.js')
    expect(typeof mod.createContainer).toBe('function')
    expect(typeof mod.createEventBus).toBe('function')
    expect(typeof mod.ModelRegistry).toBe('function')
    expect(typeof mod.ForgeError).toBe('function')
    expect(typeof mod.invokeWithTimeout).toBe('function')
    expect(typeof mod.SSETransformer).toBe('function')
  })

  it('exports config helpers', async () => {
    const mod = await import('../facades/quick-start.js')
    expect(mod.DEFAULT_CONFIG).toBeDefined()
    expect(typeof mod.resolveConfig).toBe('function')
    expect(typeof mod.mergeConfigs).toBe('function')
  })

  it('exports memory and context basics', async () => {
    const mod = await import('../facades/quick-start.js')
    expect(typeof mod.MemoryService).toBe('function')
    expect(typeof mod.createStore).toBe('function')
    expect(typeof mod.shouldSummarize).toBe('function')
    expect(typeof mod.evictIfNeeded).toBe('function')
    expect(typeof mod.scoreCompleteness).toBe('function')
  })

  it('createQuickAgent wires container correctly', async () => {
    const { createQuickAgent } = await import('../facades/quick-start.js')
    const result = createQuickAgent({
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
    const { createQuickAgent } = await import('../facades/quick-start.js')
    const result = createQuickAgent({
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

describe('facades/memory', () => {
  it('exports core memory APIs', async () => {
    const mod = await import('../facades/memory.js')
    expect(typeof mod.MemoryService).toBe('function')
    expect(typeof mod.createStore).toBe('function')
    expect(typeof mod.calculateStrength).toBe('function')
    expect(typeof mod.sanitizeMemoryContent).toBe('function')
    expect(typeof mod.consolidateNamespace).toBe('function')
    expect(typeof mod.fusionSearch).toBe('function')
    expect(typeof mod.WorkingMemory).toBe('function')
  })

  it('exports retrieval strategies', async () => {
    const mod = await import('../facades/memory.js')
    expect(typeof mod.AdaptiveRetriever).toBe('function')
    expect(typeof mod.classifyIntent).toBe('function')
    expect(typeof mod.voidFilter).toBe('function')
    expect(typeof mod.rerank).toBe('function')
    expect(typeof mod.computePPR).toBe('function')
  })

  it('exports advanced memory subsystems', async () => {
    const mod = await import('../facades/memory.js')
    expect(typeof mod.TemporalMemoryService).toBe('function')
    expect(typeof mod.ScopedMemoryService).toBe('function')
    expect(typeof mod.DualStreamWriter).toBe('function')
    expect(typeof mod.SleepConsolidator).toBe('function')
    expect(typeof mod.ObservationalMemory).toBe('function')
    expect(typeof mod.ProvenanceWriter).toBe('function')
  })
})

describe('facades/orchestration', () => {
  it('exports event bus and agent bus', async () => {
    const mod = await import('../facades/orchestration.js')
    expect(typeof mod.createEventBus).toBe('function')
    expect(typeof mod.AgentBus).toBe('function')
  })

  it('exports routing', async () => {
    const mod = await import('../facades/orchestration.js')
    expect(typeof mod.IntentRouter).toBe('function')
    expect(typeof mod.KeywordMatcher).toBe('function')
    expect(typeof mod.CostAwareRouter).toBe('function')
    expect(typeof mod.ModelTierEscalationPolicy).toBe('function')
  })

  it('exports pipeline schemas', async () => {
    const mod = await import('../facades/orchestration.js')
    expect(mod.PipelineDefinitionSchema).toBeDefined()
    expect(typeof mod.serializePipeline).toBe('function')
    expect(typeof mod.deserializePipeline).toBe('function')
    expect(typeof mod.autoLayout).toBe('function')
  })

  it('exports sub-agent and skill management', async () => {
    const mod = await import('../facades/orchestration.js')
    expect(typeof mod.SubAgentSpawner).toBe('function')
    expect(typeof mod.SkillLoader).toBe('function')
    expect(typeof mod.SkillManager).toBe('function')
    expect(typeof mod.SkillLearner).toBe('function')
    expect(typeof mod.parseAgentsMd).toBe('function')
  })

  it('exports protocol messaging', async () => {
    const mod = await import('../facades/orchestration.js')
    expect(typeof mod.createForgeMessage).toBe('function')
    expect(typeof mod.createResponse).toBe('function')
    expect(typeof mod.ProtocolRouter).toBe('function')
    expect(typeof mod.ProtocolBridge).toBe('function')
  })

  it('exports persistence stores', async () => {
    const mod = await import('../facades/orchestration.js')
    expect(typeof mod.InMemoryRunStore).toBe('function')
    expect(typeof mod.InMemoryAgentStore).toBe('function')
    expect(typeof mod.InMemoryEventLog).toBe('function')
  })

  it('exports concurrency and observability', async () => {
    const mod = await import('../facades/orchestration.js')
    expect(typeof mod.Semaphore).toBe('function')
    expect(typeof mod.ConcurrencyPool).toBe('function')
    expect(typeof mod.MetricsCollector).toBe('function')
    expect(typeof mod.HealthAggregator).toBe('function')
  })
})

describe('facades/security', () => {
  it('exports risk classification', async () => {
    const mod = await import('../facades/security.js')
    expect(typeof mod.createRiskClassifier).toBe('function')
  })

  it('exports secrets scanning and PII detection', async () => {
    const mod = await import('../facades/security.js')
    expect(typeof mod.scanForSecrets).toBe('function')
    expect(typeof mod.redactSecrets).toBe('function')
    expect(typeof mod.detectPII).toBe('function')
    expect(typeof mod.redactPII).toBe('function')
  })

  it('exports output pipeline', async () => {
    const mod = await import('../facades/security.js')
    expect(typeof mod.OutputPipeline).toBe('function')
    expect(typeof mod.createDefaultPipeline).toBe('function')
  })

  it('exports policy engine', async () => {
    const mod = await import('../facades/security.js')
    expect(typeof mod.PolicyEvaluator).toBe('function')
    expect(typeof mod.InMemoryPolicyStore).toBe('function')
    expect(typeof mod.PolicyTranslator).toBe('function')
  })

  it('exports audit trail', async () => {
    const mod = await import('../facades/security.js')
    expect(typeof mod.ComplianceAuditLogger).toBe('function')
    expect(typeof mod.InMemoryAuditStore).toBe('function')
  })

  it('exports safety monitor', async () => {
    const mod = await import('../facades/security.js')
    expect(typeof mod.createSafetyMonitor).toBe('function')
    expect(typeof mod.getBuiltInRules).toBe('function')
  })

  it('exports memory defense', async () => {
    const mod = await import('../facades/security.js')
    expect(typeof mod.createMemoryDefense).toBe('function')
  })

  it('exports data classification', async () => {
    const mod = await import('../facades/security.js')
    expect(typeof mod.DataClassifier).toBe('function')
    expect(mod.DEFAULT_CLASSIFICATION_PATTERNS).toBeDefined()
  })

  it('exports tool permission defaults', async () => {
    const mod = await import('../facades/security.js')
    expect(Array.isArray(mod.DEFAULT_AUTO_APPROVE_TOOLS)).toBe(true)
    expect(Array.isArray(mod.DEFAULT_LOG_TOOLS)).toBe(true)
    expect(Array.isArray(mod.DEFAULT_REQUIRE_APPROVAL_TOOLS)).toBe(true)
  })
})

describe('facades/index (namespace re-exports)', () => {
  it('exports all four namespaces', async () => {
    const mod = await import('../facades/index.js')
    expect(mod.quickStart).toBeDefined()
    expect(mod.memory).toBeDefined()
    expect(mod.orchestration).toBeDefined()
    expect(mod.security).toBeDefined()
  })

  it('namespaces contain expected symbols', async () => {
    const mod = await import('../facades/index.js')
    expect(typeof mod.quickStart.createQuickAgent).toBe('function')
    expect(typeof mod.memory.MemoryService).toBe('function')
    expect(typeof mod.orchestration.IntentRouter).toBe('function')
    expect(typeof mod.security.PolicyEvaluator).toBe('function')
  })
})
