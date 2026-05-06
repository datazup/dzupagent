import { describe, it, expect } from 'vitest'
import * as quickStartMod from '../facades/quick-start.js'
import * as orchestrationMod from '../facades/orchestration.js'
import * as securityMod from '../facades/security.js'
import * as facadesIndexMod from '../facades/index.js'
import * as stableMod from '../stable.js'
import * as advancedMod from '../advanced.js'
import * as rootMod from '../index.js'

// ---------------------------------------------------------------------------
// Validate that each facade re-exports the expected symbols without pulling
// in the full index.ts surface. These are structural smoke tests — they
// confirm that the module graph resolves and key symbols are available.
//
// NOTE: The `memory` facade was removed in MC-A01 (core -> memory layer
// inversion fix). Memory symbols must be imported from @dzupagent/memory.
// ---------------------------------------------------------------------------

describe('facades/quick-start', () => {
  it('exports createQuickAgent helper', async () => {
    expect(typeof quickStartMod.createQuickAgent).toBe('function')
  }, 15_000)

  it('exports core building blocks', async () => {
    expect(typeof quickStartMod.createContainer).toBe('function')
    expect(typeof quickStartMod.createEventBus).toBe('function')
    expect(typeof quickStartMod.ModelRegistry).toBe('function')
    expect(typeof quickStartMod.ForgeError).toBe('function')
    expect(typeof quickStartMod.invokeWithTimeout).toBe('function')
    expect(typeof quickStartMod.SSETransformer).toBe('function')
  })

  it('exports config helpers', async () => {
    expect(quickStartMod.DEFAULT_CONFIG).toBeDefined()
    expect(typeof quickStartMod.resolveConfig).toBe('function')
    expect(typeof quickStartMod.mergeConfigs).toBe('function')
  })

  it('createQuickAgent wires container correctly', async () => {
    const result = quickStartMod.createQuickAgent({
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
    const result = quickStartMod.createQuickAgent({
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
  it('exports event bus and agent bus', async () => {
    expect(typeof orchestrationMod.createEventBus).toBe('function')
    expect(typeof orchestrationMod.AgentBus).toBe('function')
  })

  it('exports routing', async () => {
    expect(typeof orchestrationMod.IntentRouter).toBe('function')
    expect(typeof orchestrationMod.KeywordMatcher).toBe('function')
    expect(typeof orchestrationMod.CostAwareRouter).toBe('function')
    expect(typeof orchestrationMod.ModelTierEscalationPolicy).toBe('function')
  })

  it('exports pipeline schemas', async () => {
    expect(orchestrationMod.PipelineDefinitionSchema).toBeDefined()
    expect(typeof orchestrationMod.serializePipeline).toBe('function')
    expect(typeof orchestrationMod.deserializePipeline).toBe('function')
    expect(typeof orchestrationMod.autoLayout).toBe('function')
  })

  it('exports sub-agent and skill management', async () => {
    expect(typeof orchestrationMod.SubAgentSpawner).toBe('function')
    expect(typeof orchestrationMod.SkillLoader).toBe('function')
    expect(typeof orchestrationMod.SkillManager).toBe('function')
    expect(typeof orchestrationMod.SkillLearner).toBe('function')
    expect(typeof orchestrationMod.parseAgentsMd).toBe('function')
  })

  it('exports protocol messaging', async () => {
    expect(typeof orchestrationMod.createForgeMessage).toBe('function')
    expect(typeof orchestrationMod.createResponse).toBe('function')
    expect(typeof orchestrationMod.ProtocolRouter).toBe('function')
    expect(typeof orchestrationMod.ProtocolBridge).toBe('function')
  })

  it('exports persistence stores', async () => {
    expect(typeof orchestrationMod.InMemoryRunStore).toBe('function')
    expect(typeof orchestrationMod.InMemoryAgentStore).toBe('function')
    expect(typeof orchestrationMod.InMemoryEventLog).toBe('function')
  })

  it('exports concurrency and observability', async () => {
    expect(typeof orchestrationMod.Semaphore).toBe('function')
    expect(typeof orchestrationMod.ConcurrencyPool).toBe('function')
    expect(typeof orchestrationMod.MetricsCollector).toBe('function')
    expect(typeof orchestrationMod.HealthAggregator).toBe('function')
  })
})

describe('facades/security', () => {
  it('exports risk classification', async () => {
    expect(typeof securityMod.createRiskClassifier).toBe('function')
  })

  it('exports secrets scanning and PII detection', async () => {
    expect(typeof securityMod.scanForSecrets).toBe('function')
    expect(typeof securityMod.redactSecrets).toBe('function')
    expect(typeof securityMod.detectPII).toBe('function')
    expect(typeof securityMod.redactPII).toBe('function')
  })

  it('exports output pipeline', async () => {
    expect(typeof securityMod.OutputPipeline).toBe('function')
    expect(typeof securityMod.createDefaultPipeline).toBe('function')
  })

  it('exports policy engine', async () => {
    expect(typeof securityMod.PolicyEvaluator).toBe('function')
    expect(typeof securityMod.InMemoryPolicyStore).toBe('function')
    expect(typeof securityMod.PolicyTranslator).toBe('function')
  })

  it('exports audit trail', async () => {
    expect(typeof securityMod.ComplianceAuditLogger).toBe('function')
    expect(typeof securityMod.InMemoryAuditStore).toBe('function')
  })

  it('exports safety monitor', async () => {
    expect(typeof securityMod.createSafetyMonitor).toBe('function')
    expect(typeof securityMod.getBuiltInRules).toBe('function')
  })

  it('exports memory defense', async () => {
    expect(typeof securityMod.createMemoryDefense).toBe('function')
  })

  it('exports data classification', async () => {
    expect(typeof securityMod.DataClassifier).toBe('function')
    expect(securityMod.DEFAULT_CLASSIFICATION_PATTERNS).toBeDefined()
  })

  it('exports tool permission defaults', async () => {
    expect(Array.isArray(securityMod.DEFAULT_AUTO_APPROVE_TOOLS)).toBe(true)
    expect(Array.isArray(securityMod.DEFAULT_LOG_TOOLS)).toBe(true)
    expect(Array.isArray(securityMod.DEFAULT_REQUIRE_APPROVAL_TOOLS)).toBe(true)
  })
})

describe('facades/index (namespace re-exports)', () => {
  it('exports quickStart, orchestration, security namespaces', async () => {
    expect(facadesIndexMod.quickStart).toBeDefined()
    expect(facadesIndexMod.orchestration).toBeDefined()
    expect(facadesIndexMod.security).toBeDefined()
    // memory namespace removed in MC-A01; import from @dzupagent/memory directly
    expect((facadesIndexMod as Record<string, unknown>).memory).toBeUndefined()
  })

  it('namespaces contain expected symbols', async () => {
    expect(typeof facadesIndexMod.quickStart.createQuickAgent).toBe('function')
    expect(typeof facadesIndexMod.orchestration.IntentRouter).toBe('function')
    expect(typeof facadesIndexMod.security.PolicyEvaluator).toBe('function')
  })
})

describe('stable entrypoint', () => {
  it('exports the curated facade namespaces', async () => {
    expect(stableMod.quickStart).toBeDefined()
    expect(stableMod.orchestration).toBeDefined()
    expect(stableMod.security).toBeDefined()
    // memory namespace removed in MC-A01
    expect((stableMod as Record<string, unknown>).memory).toBeUndefined()
  })

  it('keeps access through the facade namespaces', async () => {
    expect(typeof stableMod.quickStart.createQuickAgent).toBe('function')
    expect(typeof stableMod.orchestration.IntentRouter).toBe('function')
    expect(typeof stableMod.security.PolicyEvaluator).toBe('function')
  })
})

describe('advanced entrypoint', () => {
  it('re-exports representative root symbols', async () => {
    expect(typeof advancedMod.createContainer).toBe('function')
    expect(typeof advancedMod.createEventBus).toBe('function')
    expect(typeof advancedMod.ModelRegistry).toBe('function')
    expect(typeof advancedMod.IntentRouter).toBe('function')
    expect(typeof advancedMod.createRiskClassifier).toBe('function')
  })

  it('tracks the current root entrypoint for compatibility', async () => {
    expect(advancedMod.createContainer).toBe(rootMod.createContainer)
    expect(advancedMod.createEventBus).toBe(rootMod.createEventBus)
    expect(advancedMod.ModelRegistry).toBe(rootMod.ModelRegistry)
  })
})
