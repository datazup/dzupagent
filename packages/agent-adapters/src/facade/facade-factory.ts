/**
 * createOrchestrator — factory for OrchestratorFacade.
 *
 * Composes the AdapterPipeline (policy + approval + guardrails + UCL) and
 * injects it into a new OrchestratorFacade alongside the registry, sessions,
 * event bus, and bridge. Extracted from `orchestrator-facade.ts` to keep the
 * class file focused on runtime behaviour.
 */

import { createEventBus } from '@dzupagent/core/events'

import { CostTrackingMiddleware } from '../middleware/cost-tracking.js'
import { withMemoryEnrichment } from '../middleware/memory-enrichment.js'
import {
  AdapterPipeline,
  ApprovalPipelineStep,
  GuardrailsPipelineStep,
  PolicyEnforcementPipeline,
  UCLEnrichmentStep,
} from '../pipeline/index.js'
import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import { EventBusBridge } from '../registry/event-bus-bridge.js'
import { SessionRegistry } from '../session/session-registry.js'

import { OrchestrationPatterns } from './orchestration-patterns.js'
import { OrchestratorFacade } from './orchestrator-facade-class.js'
import type { OrchestratorConfig } from './orchestrator-facade-types.js'

/**
 * Factory function — preferred way to create an orchestrator.
 *
 * @example
 * ```ts
 * const orchestrator = createOrchestrator({
 *   adapters: [new ClaudeAgentAdapter(), new CodexAdapter()],
 *   enableCostTracking: true,
 *   costTrackingConfig: { maxBudgetCents: 500 },
 * })
 *
 * const result = await orchestrator.run('Fix the failing test')
 * ```
 */
export function createOrchestrator(config: OrchestratorConfig): OrchestratorFacade {
  const eventBus = config.eventBus ?? createEventBus()

  const registry = new ProviderAdapterRegistry(
    config.circuitBreakerConfig
      ? { circuitBreaker: config.circuitBreakerConfig }
      : undefined,
  )
  registry.setEventBus(eventBus)

  if (config.router) {
    registry.setRouter(config.router)
  }

  const adaptersToRegister = config.memoryEnrichment
    ? config.adapters.map(a => withMemoryEnrichment(a, config.memoryEnrichment!))
    : config.adapters

  for (const adapter of adaptersToRegister) {
    registry.register(adapter)
  }

  const bridge = new EventBusBridge(eventBus)

  const enableCost = config.enableCostTracking ?? true
  const costTracking = enableCost
    ? new CostTrackingMiddleware({
        eventBus,
        ...config.costTrackingConfig,
      })
    : undefined

  const sessions = new SessionRegistry({ eventBus })

  const pipeline = new AdapterPipeline(
    new PolicyEnforcementPipeline(
      registry,
      undefined,
      config.policyConformanceMode ?? 'strict',
    ),
    new ApprovalPipelineStep(config.approvalGate),
    new GuardrailsPipelineStep(costTracking, config.guardrails),
    new UCLEnrichmentStep(registry, eventBus, config.dzupagent),
  )
  const patterns = new OrchestrationPatterns(registry, eventBus)

  return new OrchestratorFacade(registry, pipeline, patterns, sessions, {
    bridge,
    costTracking,
    defaultPolicy: config.defaultPolicy,
  })
}
