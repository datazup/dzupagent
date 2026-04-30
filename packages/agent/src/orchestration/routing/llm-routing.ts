import type {
  AgentSpec,
  AgentTask,
  LLMRoutingConfig,
  RoutingDecision,
  RoutingDiagnostics,
  RoutingPolicy,
} from '../routing-policy-types.js'

/**
 * LLMRouting -- provider-neutral adapter for model-selected routing.
 *
 * This policy does not call a model directly. Callers adapt their own model
 * output through `selector`, and must choose an explicit deterministic fallback
 * so a policy named LLMRouting can no longer silently pass through every
 * candidate.
 */
export class LLMRouting implements RoutingPolicy {
  constructor(private readonly config: LLMRoutingConfig) {
    if (!config) {
      throw new Error('LLMRouting requires explicit fallback semantics')
    }
  }

  select(task: AgentTask, candidates: AgentSpec[]): RoutingDecision {
    const candidateIds = candidates.map((candidate) => candidate.id)

    if (this.config.selector) {
      const selection = this.config.selector(task, candidates)
      const decision = this.toDecision(selection, candidates)
      if (decision && decision.selected.length > 0) {
        return this.withDiagnostics(decision, candidates)
      }

      return this.createFallbackDecision(
        candidates,
        'LLM routing fallback: selector returned no valid candidates',
      )
    }

    return this.createFallbackDecision(
      candidates,
      `LLM routing fallback: no selector configured; using explicit '${this.config.fallback}' fallback over candidates [${candidateIds.join(', ')}]`,
    )
  }

  /**
   * Create a decision from an LLM-selected agent ID.
   * Called by the supervisor after its LLM makes a selection.
   */
  createDecision(agentId: string, candidates: AgentSpec[], llmReason?: string): RoutingDecision {
    const agent = candidates.find((a) => a.id === agentId)
    if (agent) {
      return this.withDiagnostics({
        selected: [agent],
        reason: llmReason ?? `LLM selected agent '${agentId}'`,
        strategy: 'llm',
      }, candidates)
    }

    return this.createFallbackDecision(
      candidates,
      `LLM routing fallback: selected agent '${agentId}' is not in the candidate set`,
      llmReason,
    )
  }

  private toDecision(
    selection: ReturnType<NonNullable<LLMRoutingConfig['selector']>>,
    candidates: AgentSpec[],
  ): RoutingDecision | undefined {
    if (!selection) return undefined

    if (typeof selection === 'object' && 'selected' in selection) {
      const selectedIds = new Set(selection.selected.map((candidate) => candidate.id))
      const selected = candidates.filter((candidate) => selectedIds.has(candidate.id))
      if (selected.length === 0) return undefined
      return {
        ...selection,
        selected,
      }
    }

    const selections = Array.isArray(selection) ? selection : [selection]
    const selectedIds = new Set(selections.map((item) =>
      typeof item === 'string' ? item : item.id,
    ))
    const selected = candidates.filter((candidate) => selectedIds.has(candidate.id))
    if (selected.length === 0) return undefined

    return {
      selected,
      reason: `LLM selected candidate(s): ${selected.map((candidate) => candidate.id).join(', ')}`,
      strategy: 'llm',
    }
  }

  private createFallbackDecision(
    candidates: AgentSpec[],
    fallbackReason: string,
    llmReason?: string,
  ): RoutingDecision {
    const selected = this.config.fallback === 'pass-through'
      ? candidates
      : candidates.slice(0, 1)

    return this.withDiagnostics({
      selected,
      reason: llmReason ?? fallbackReason,
      strategy: 'llm',
      fallbackReason,
    }, candidates)
  }

  private withDiagnostics(decision: RoutingDecision, candidates: AgentSpec[]): RoutingDecision {
    const fallbackReason = decision.fallbackReason
    const diagnostics: RoutingDiagnostics = {
      candidateIds: candidates.map((candidate) => candidate.id),
      selectedIds: decision.selected.map((candidate) => candidate.id),
      ...(fallbackReason ? { fallbackReason } : {}),
    }

    return {
      ...decision,
      ...(fallbackReason ? { fallbackReason } : {}),
      diagnostics,
    }
  }
}
