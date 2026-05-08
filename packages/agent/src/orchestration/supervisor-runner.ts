/**
 * Supervisor execution — manager agent delegates to specialist agents via
 * tools.
 *
 * Each specialist is converted to a LangChain tool via `asTool()` and injected
 * into a new manager agent instance. The manager LLM then invokes specialists
 * through standard function calling. Results flow back as ToolMessages.
 *
 * Includes a per-manager / per-specialist-set cache for the synthesized
 * "manager-with-tools" `DzupAgent`, since constructing it (model bind,
 * instruction templating, tool wiring) is non-trivial.
 */
import { HumanMessage } from '@langchain/core/messages'
import { defaultLogger } from '@dzupagent/core/utils'
import { DzupAgent } from '../agent/dzip-agent.js'
import { omitUndefined } from '../utils/exact-optional.js'
import { OrchestrationError } from './orchestration-error.js'
import type { AgentSpec, AgentTask } from './routing-policy-types.js'
import { instrumentSpecialistTool } from './specialist-tool-instrumentation.js'
import type { SupervisorConfig, SupervisorResult } from './supervisor-types.js'

/**
 * Cache of manager-with-tools `DzupAgent` instances keyed by manager object
 * identity and sorted specialist ids.
 *
 * Invalidation:
 * - Outer key is a `WeakMap` on the manager instance: a different manager
 *   object is a different cache entry even if its id matches.
 * - Inner key is the sorted specialist id list. To guard against collisions
 *   where two distinct specialist instances share the same id (test fixtures
 *   and pooled rebuilds), the cached entry remembers the exact specialist
 *   instances and is invalidated if any differs.
 */
let supervisorAgentCache = new WeakMap<
  DzupAgent,
  Map<string, { agent: DzupAgent; specialists: readonly DzupAgent[] }>
>()

/**
 * Clear the supervisor agent cache. Use when the lifecycle owner of the
 * orchestrator is being torn down or when underlying agent configuration is
 * known to have changed.
 */
export function clearSupervisorCache(): void {
  supervisorAgentCache = new WeakMap()
}

/**
 * Normalized argument bundle for {@link runSupervisor}. Callers typically use
 * `AgentOrchestrator.supervisor()` which handles the legacy positional
 * overload before delegating here.
 */
export async function runSupervisor(config: SupervisorConfig): Promise<SupervisorResult> {
  const { manager, task, signal, executionMode, providerPort, routingPolicy, circuitBreaker } = config
  const eventBus = config.eventBus ?? manager.agentConfig.eventBus
  let { specialists } = config

  // Provider-adapter execution mode: route through the injected port.
  // This mode is explicitly configured, so fail closed when the port is absent
  // instead of silently falling back to local specialist execution.
  if (executionMode === 'provider-adapter') {
    if (!providerPort) {
      throw new OrchestrationError(
        'supervisor() provider-adapter executionMode requires providerPort',
        'supervisor',
        { managerId: manager.id },
      )
    }

    const portResult = await providerPort.run(
      omitUndefined({ prompt: task, signal }),
      { prompt: task, tags: specialists.map((s) => s.id) },
      omitUndefined({ signal }),
    )

    return {
      content: portResult.content,
      availableSpecialists: specialists.map((s) => s.id),
      filteredSpecialists: [],
    }
  }

  // Validate inputs
  if (specialists.length === 0) {
    throw new OrchestrationError(
      'supervisor() requires at least one specialist agent',
      'supervisor',
      { managerId: manager.id },
    )
  }

  // Check abort before starting
  if (signal?.aborted) {
    throw new OrchestrationError(
      'supervisor() aborted before execution',
      'supervisor',
      { managerId: manager.id },
    )
  }

  // Filter specialists through circuit breaker if configured
  if (circuitBreaker) {
    const candidateSpecialists = specialists.map((s) => s.id)
    const before = specialists.length
    specialists = circuitBreaker.filterAvailable(specialists)
    if (specialists.length < before) {
      const removedIds = config.specialists
        .filter((s) => !specialists.includes(s))
        .map((s) => s.id)
      eventBus?.emit({
        type: 'supervisor:routing_decision',
        managerId: manager.id,
        task,
        strategy: 'circuit-breaker',
        reason: 'Excluded specialists with open circuits',
        selectedSpecialists: specialists.map((s) => s.id),
        filteredSpecialists: removedIds,
        candidateSpecialists,
        source: 'direct-supervisor',
      })
      // Log filtered agents for observability when no event bus is wired.
      if (!eventBus) {
        defaultLogger.debug('[AgentOrchestrator] Circuit breaker filtered agents', { removedIds })
      }
    }

    if (specialists.length === 0) {
      throw new OrchestrationError(
        'All specialists filtered by circuit breaker',
        'supervisor',
        { managerId: manager.id },
      )
    }
  }

  // Apply routing policy if configured to narrow specialist selection
  if (routingPolicy) {
    const candidates: AgentSpec[] = specialists.map((s) => ({
      id: s.id,
      name: s.id,
      tags: [],
    }))
    const candidateSpecialists = candidates.map((s) => s.id)
    const agentTask: AgentTask = {
      taskId: `supervisor-${Date.now()}`,
      content: task,
    }
    const decision = routingPolicy.select(agentTask, candidates)
    const selectedIds = new Set(decision.selected.map((a) => a.id))
    specialists = specialists.filter((s) => selectedIds.has(s.id))
    const selectedSpecialists = specialists.map((s) => s.id)
    const filteredSpecialists = candidateSpecialists.filter((id) => !selectedIds.has(id))

    const routingEvent = omitUndefined({
      type: 'supervisor:routing_decision',
      managerId: manager.id,
      task,
      taskId: agentTask.taskId,
      strategy: decision.strategy,
      reason: decision.reason,
      fallbackReason: decision.fallbackReason,
      selectedSpecialists,
      selectedCandidates: decision.diagnostics?.selectedIds ?? selectedSpecialists,
      filteredSpecialists,
      candidateSpecialists,
      source: 'direct-supervisor',
    } as const)
    eventBus?.emit(routingEvent)
    if (!eventBus) {
      defaultLogger.debug('[AgentOrchestrator] Routing decision', {
        selected: selectedSpecialists,
        strategy: decision.strategy,
        reason: decision.reason,
        fallbackReason: decision.fallbackReason,
      })
    }
  }

  // Optional health check: filter out unresponsive specialists
  const filteredSpecialists: string[] = []
  if (config.healthCheck) {
    const healthySpecialists: DzupAgent[] = []
    for (const specialist of specialists) {
      try {
        // Lightweight check: just verify asTool() resolves without error
        await specialist.asTool()
        healthySpecialists.push(specialist)
      } catch {
        filteredSpecialists.push(specialist.id)
      }
    }

    if (healthySpecialists.length === 0) {
      throw new OrchestrationError(
        'All specialists failed health check',
        'supervisor',
        { managerId: manager.id, filteredSpecialists },
      )
    }

    specialists = healthySpecialists
  }

  const availableSpecialists = specialists.map(s => s.id)

  // Memoize the manager-with-tools DzupAgent per manager instance and
  // sorted specialist ids only when specialist tools do not capture
  // per-call circuit breaker state.
  // Constructing the supervisor agent (and its specialist tools via asTool())
  // is non-trivial; when callers reuse a stable specialist set across many
  // supervisor() invocations, this avoids paying full init cost each time.
  const managerConfig = manager.agentConfig
  // Build the canonical (sorted-by-id) specialist list once; both the
  // cache key and the identity guard read from this list.
  const canonicalSpecialists = [...specialists].sort((a, b) => a.id.localeCompare(b.id))
  const sortedSpecialistIds = canonicalSpecialists.map(s => s.id)
  const cacheKey = circuitBreaker ? undefined : sortedSpecialistIds.join(',')
  const managerCache = cacheKey
    ? supervisorAgentCache.get(manager)
    : undefined
  const cachedEntry = cacheKey ? managerCache?.get(cacheKey) : undefined

  // Cache hit only if every cached specialist instance is identical
  // (===) to the corresponding canonical specialist; otherwise the
  // cached supervisor wraps stale tools / models.
  const cachedSpecialistsMatch =
    !!cachedEntry &&
    cachedEntry.specialists.length === canonicalSpecialists.length &&
    cachedEntry.specialists.every((s, i) => s === canonicalSpecialists[i])

  let managerWithTools = cachedSpecialistsMatch ? cachedEntry.agent : undefined

  if (!managerWithTools) {
    // Convert each specialist into a LangChain tool
    const specialistTools = await Promise.all(
      specialists.map(async (s) => instrumentSpecialistTool(
        await s.asTool(),
        s.id,
        circuitBreaker,
      )),
    )

    // Create a new manager agent instance with specialist tools injected
    // alongside any tools the manager already has.
    managerWithTools = new DzupAgent({
      ...managerConfig,
      id: `${managerConfig.id}__supervisor`,
      tools: [...(managerConfig.tools ?? []), ...specialistTools],
      instructions: managerConfig.instructions +
        '\n\nYou are a supervisor agent. You have access to specialist agent tools. ' +
        'Delegate sub-tasks to the appropriate specialist by calling their tool. ' +
        'Synthesize specialist responses into a coherent final answer.',
    })

    if (cacheKey) {
      const cache = managerCache ?? new Map<string, { agent: DzupAgent; specialists: readonly DzupAgent[] }>()
      cache.set(cacheKey, { agent: managerWithTools, specialists: canonicalSpecialists })
      if (!managerCache) {
        supervisorAgentCache.set(manager, cache)
      }
    }
  }

  // Run the manager with the task -- the LLM will invoke specialist tools
  // via function calling, and the tool loop handles ToolMessage flow.
  const result = await managerWithTools.generate(
    [new HumanMessage(task)],
    omitUndefined({ signal }),
  )

  return {
    content: result.content,
    availableSpecialists,
    filteredSpecialists,
  }
}
