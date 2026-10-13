/**
 * GuardrailsPipelineStep — extracted from OrchestratorFacade.
 *
 * Holds references to optional cost-tracking and guardrails middleware and
 * wraps an event stream with whichever are configured. Replaces the
 * `applyPostStreamWrappers` method of the facade.
 */

import type { CostTrackingMiddleware } from '../middleware/cost-tracking.js'
import { AdapterGuardrails } from '../guardrails/adapter-guardrails.js'
import type { AdapterGuardrailsConfig } from '../guardrails/adapter-guardrails-types.js'
import type { AgentInput, AgentStreamEvent } from '../types.js'
import { POLICY_GUARDRAILS_OPTION_KEY } from './policy-enforcement-pipeline.js'
import { mergeAbortSignals } from '../utils/abort-signal-helpers.js'

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
    input?: AgentInput,
  ): AsyncGenerator<T, void, undefined> {
    const overlayConfig = this.readPolicyGuardrailOverlay(input)
    if (!this.enabled && !overlayConfig) return stream

    // Update the shared input before the lazy provider stream is consumed.
    // Closing an iterator alone does not cancel the underlying provider work.
    const controller = new AbortController()
    const merged = mergeAbortSignals(input?.signal, controller.signal)
    if (input) input.signal = merged.signal
    const abort = (): void => controller.abort()
    let wrapped = stream

    if (this._costTracking) {
      wrapped = this._costTracking.wrap(wrapped, abort) as AsyncGenerator<T, void, undefined>
    }

    if (this._guardrails) {
      wrapped = this._guardrails.wrap(wrapped, abort) as AsyncGenerator<T, void, undefined>
    }

    if (overlayConfig) {
      const overlay = new AdapterGuardrails(overlayConfig)
      wrapped = overlay.wrap(wrapped, abort) as AsyncGenerator<T, void, undefined>
    }

    // A yield* finally runs after awaiting inner return. Intercept closure
    // first so a provider finalizer waiting for its abort signal can finish.
    return {
      async next(value?: undefined) {
        try {
          const result = await wrapped.next(value)
          if (result.done) merged.cleanup?.()
          return result
        } catch (error) {
          abort()
          merged.cleanup?.()
          throw error
        }
      },
      async return(value: void | PromiseLike<void>) {
        abort()
        try { return await wrapped.return(value) }
        finally { merged.cleanup?.() }
      },
      async throw(error: unknown) {
        abort()
        try { return await wrapped.throw(error) }
        finally { merged.cleanup?.() }
      },
      [Symbol.asyncIterator]() { return this },
    }
  }

  private readPolicyGuardrailOverlay(input: AgentInput | undefined): AdapterGuardrailsConfig | undefined {
    const typed = input?.policyContext?.projectedGuardrails
    if (typed && typeof typed === 'object') {
      const fromTyped = this.normalizeGuardrailOverlay(typed as Record<string, unknown>)
      if (fromTyped) return fromTyped
    }

    // Backward compatibility for callers that still pass policy metadata via options.
    const raw = input?.options?.[POLICY_GUARDRAILS_OPTION_KEY]
    if (!raw || typeof raw !== 'object') return undefined
    return this.normalizeGuardrailOverlay(raw as Record<string, unknown>)
  }

  private normalizeGuardrailOverlay(obj: Record<string, unknown>): AdapterGuardrailsConfig | undefined {
    const blockedTools = Array.isArray(obj['blockedTools'])
      ? obj['blockedTools'].filter((v): v is string => typeof v === 'string' && v.length > 0)
      : undefined
    const maxIterations = typeof obj['maxIterations'] === 'number' ? obj['maxIterations'] : undefined
    const maxCostCents = typeof obj['maxCostCents'] === 'number' ? obj['maxCostCents'] : undefined

    if (
      maxIterations === undefined &&
      maxCostCents === undefined &&
      (blockedTools === undefined || blockedTools.length === 0)
    ) {
      return undefined
    }

    return {
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(maxCostCents !== undefined ? { maxCostCents } : {}),
      ...(blockedTools && blockedTools.length > 0 ? { blockedTools } : {}),
    }
  }
}
