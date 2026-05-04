/**
 * GuardrailsPipelineStep — extracted from OrchestratorFacade.
 *
 * Holds references to optional cost-tracking and guardrails middleware and
 * wraps an event stream with whichever are configured. Replaces the
 * `applyPostStreamWrappers` method of the facade.
 */

import type { CostTrackingMiddleware } from '../middleware/cost-tracking.js'
import type { AdapterGuardrails } from '../guardrails/adapter-guardrails.js'
import type { AgentStreamEvent } from '../types.js'

export class GuardrailsPipelineStep {
  constructor(
    private readonly _costTracking: CostTrackingMiddleware | undefined,
    private readonly _guardrails: AdapterGuardrails | undefined,
  ) {}

  /** True when at least one wrapper is active. */
  get enabled(): boolean {
    return this._costTracking !== undefined || this._guardrails !== undefined
  }

  /**
   * Apply post-stream wrappers in priority order:
   *   1. Cost tracking
   *   2. Guardrails
   *
   * Returns the original stream unchanged when no wrappers are configured.
   */
  wrap<T extends AgentStreamEvent>(
    stream: AsyncGenerator<T, void, undefined>,
  ): AsyncGenerator<T, void, undefined> {
    let wrapped = stream

    if (this._costTracking) {
      wrapped = this._costTracking.wrap(wrapped) as AsyncGenerator<T, void, undefined>
    }

    if (this._guardrails) {
      wrapped = this._guardrails.wrap(wrapped) as AsyncGenerator<T, void, undefined>
    }

    return wrapped
  }
}
