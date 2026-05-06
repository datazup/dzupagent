/**
 * ResilientModelInvoker — walks the provider fallback chain on transient errors.
 *
 * Complements ModelRegistry.getModelFallbackCandidates() (selection-time fallback)
 * with invocation-time fallback: if provider A throws a transient error during
 * model.invoke(), the invoker automatically retries on provider B, etc.
 *
 * Non-transient errors (auth failures, context-length errors, schema errors) are
 * thrown immediately without falling back, since retrying on a different provider
 * is unlikely to recover.
 */
import type { BaseMessage } from '@langchain/core/messages'
import { ForgeError } from '../errors/forge-error.js'
import { invokeWithTimeout, type InvokeOptions } from './invoke.js'
import type { ModelFallbackCandidate, ModelRegistry } from './model-registry.js'
import { isTransientError } from './retry.js'

export interface ResilientInvokerOptions extends InvokeOptions {
  /**
   * Emit event on fallback hop. Receives the failing provider name, the next
   * provider name, and the transient error that triggered the hop.
   */
  onFallback?: (
    failingProvider: string,
    nextProvider: string,
    error: Error,
  ) => void
  /**
   * Record breaker state on the registry after each hop.
   *
   * When `true` (default) and a `registry` was supplied, every successful or
   * failed candidate invocation calls `recordProviderSuccess` /
   * `recordProviderFailure` on the registry to keep its circuit breakers in
   * sync with run-level outcomes.
   */
  updateBreakers?: boolean
}

/**
 * Strips the invoker-specific options before forwarding to {@link invokeWithTimeout}.
 */
function toInvokeOptions(options?: ResilientInvokerOptions): InvokeOptions | undefined {
  if (!options) return undefined
  const {
    onFallback: _onFallback,
    updateBreakers: _updateBreakers,
    ...rest
  } = options
  return rest
}

/**
 * Coerce an unknown thrown value into an `Error`.
 */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

export class ResilientModelInvoker {
  constructor(
    private readonly candidates: ModelFallbackCandidate[],
    private readonly registry?: ModelRegistry,
    private readonly options?: ResilientInvokerOptions,
  ) {}

  /**
   * Invoke with automatic fallback to the next provider on transient errors.
   *
   * - Non-transient errors (e.g. `CONTEXT_LENGTH_EXCEEDED`, auth) bubble up immediately.
   * - On any candidate success, the registry breaker is recorded as success.
   * - On a transient candidate failure, the registry breaker is recorded as failure
   *   and the next candidate is tried.
   *
   * @throws ForgeError(ALL_PROVIDERS_EXHAUSTED) if every candidate fails with a
   *   transient error.
   */
  async invoke(messages: BaseMessage[]): Promise<BaseMessage> {
    if (this.candidates.length === 0) {
      throw new ForgeError({
        code: 'ALL_PROVIDERS_EXHAUSTED',
        message: 'ResilientModelInvoker has no candidates to try',
        recoverable: false,
        suggestion: 'Ensure ModelRegistry has at least one provider configured for the requested tier',
      })
    }

    const updateBreakers = this.options?.updateBreakers ?? true
    const invokeOptions = toInvokeOptions(this.options)
    const errors: Array<{ provider: string; error: string }> = []

    for (let i = 0; i < this.candidates.length; i++) {
      const candidate = this.candidates[i]!
      try {
        const response = await invokeWithTimeout(
          candidate.model,
          messages,
          invokeOptions,
        )
        if (updateBreakers && this.registry) {
          this.registry.recordProviderSuccess(candidate.provider)
        }
        return response
      } catch (err: unknown) {
        const error = toError(err)
        errors.push({ provider: candidate.provider, error: error.message })

        // Non-transient errors should NOT trigger fallback. Re-throw immediately
        // so callers can react (compression, model-swap, surface auth error, etc).
        // ForgeError(CONTEXT_LENGTH_EXCEEDED) from invokeWithTimeout falls into
        // this branch because its message does not match the transient heuristics.
        if (!isTransientError(error)) {
          if (updateBreakers && this.registry) {
            this.registry.recordProviderFailure(candidate.provider, error)
          }
          throw err
        }

        // Transient: record failure on breaker and try the next candidate.
        if (updateBreakers && this.registry) {
          this.registry.recordProviderFailure(candidate.provider, error)
        }

        const next = this.candidates[i + 1]
        if (next && this.options?.onFallback) {
          try {
            this.options.onFallback(candidate.provider, next.provider, error)
          } catch {
            // onFallback failure is non-fatal — observability must never block
            // the fallback chain.
          }
        }
      }
    }

    throw new ForgeError({
      code: 'ALL_PROVIDERS_EXHAUSTED',
      message:
        `All ${this.candidates.length} provider candidate(s) failed with transient errors. ` +
        `Tried: ${errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`,
      recoverable: false,
      suggestion:
        'Check provider service status, rate-limit quotas, and circuit breaker configuration. ' +
        'Consider raising failureThreshold or adding additional fallback providers.',
      context: { errors },
    })
  }
}
