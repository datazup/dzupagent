/**
 * Shared provider-failover loop used by both the non-streaming
 * (`invokeModelWithProviderFailover`) and streaming
 * (`openStreamWithProviderFailover`) code paths.
 *
 * The two paths previously duplicated identical control flow:
 *
 *   - emit `provider:run_attempt`
 *   - attempt the work
 *   - on success → record success on the registry, emit `provider:run_selected`
 *   - on failure → record failure on the registry, emit `provider:run_failure`
 *     (with `retrying` reflecting the caller's policy), continue or break
 *   - after exhausting attempts → throw the last error
 *
 * Centralising the loop here also fixes a long-standing bug in the streaming
 * path: when the stream was opened successfully but consumption later threw,
 * `recordProviderSuccess` was never called for the *open* outcome. By design
 * `attemptWithFailover` records success when `execute()` resolves; a failure
 * during stream consumption is recorded by the caller (which already has the
 * `activeProvider` reference).
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { typedEmit, type DzupEventBus } from '@dzupagent/core/events'

/**
 * One candidate model + provider pair from the agent's tier fallback chain.
 *
 * Mirrors the local `ProviderAttempt` shape used by `dzip-agent.ts` and
 * `streaming-run.ts`; defined here so the shared loop has a single source
 * of truth.
 */
export interface ProviderAttempt {
  provider: string
  modelName: string
  model: BaseChatModel
}

/**
 * Minimal subset of the `ModelRegistry` surface used by the failover loop.
 *
 * Declared structurally so callers can pass either a real `ModelRegistry`
 * or a test double. Both methods are optional from the loop's perspective —
 * if `registry` is `undefined`, no breaker signalling occurs.
 */
export interface ProviderFailoverRegistry {
  recordProviderSuccess: (provider: string) => void
  recordProviderFailure: (provider: string, error: Error) => void
}

export interface AttemptWithFailoverParams<T> {
  attempts: ProviderAttempt[]
  phase: 'invoke' | 'stream'
  agentId: string
  /** Optional run identifier forwarded to all `provider:*` lifecycle events. */
  runId?: string
  /** Optional tenant identifier forwarded to all `provider:*` lifecycle events. */
  tenantId?: string
  eventBus: DzupEventBus | undefined
  registry?: ProviderFailoverRegistry | undefined
  /**
   * Optional admission gate executed once immediately before each provider
   * dispatch. A rejection aborts the failover chain without recording a
   * provider fault: no provider work has started yet, so blaming the selected
   * candidate would corrupt circuit-breaker health.
   */
  beforeAttempt?: (
    attempt: ProviderAttempt,
    attemptNumber: number,
  ) => Promise<void>
  /**
   * Optional control-plane fault classifier. Returning `false` propagates the
   * error immediately without poisoning provider health, emitting a provider
   * failure, or consulting the retry policy.
   */
  isProviderFault?: (error: Error) => boolean
  /**
   * Predicate consulted after a failure to decide whether to advance to the
   * next attempt. The loop additionally requires that there *is* a next
   * attempt; this callback only encodes the policy (transient error filter,
   * tool-result-aware behaviour, etc.).
   */
  shouldRetry: (err: Error, attemptIdx: number) => boolean
  /**
   * Performs the actual provider work for a single attempt. Returns the
   * caller-defined success payload (a `BaseMessage` for invoke,
   * `{ stream, ... }` for stream open).
   */
  execute: (attempt: ProviderAttempt, attemptNumber: number) => Promise<T>
}

/**
 * Run `attempts` in order, returning the first successful payload from
 * `execute`. Emits canonical `provider:*` lifecycle events on `eventBus`
 * and records success/failure against `registry` so the same circuit
 * breaker the agent already feeds is kept consistent across both phases.
 */
export async function attemptWithFailover<T>(
  params: AttemptWithFailoverParams<T>,
): Promise<T> {
  const { attempts, phase, agentId, runId, tenantId, eventBus, registry, beforeAttempt, isProviderFault, shouldRetry, execute } =
    params
  let lastError: unknown

  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index]!
    const attemptNumber = index + 1

    if (eventBus) {
      typedEmit(eventBus, {
        type: 'provider:run_attempt',
        agentId,
        attempt: attemptNumber,
        maxAttempts: attempts.length,
        provider: attempt.provider,
        model: attempt.modelName,
        phase,
        ...(runId !== undefined && { runId }),
        ...(tenantId !== undefined && { tenantId }),
      })
    }

    // Admission failures (for example, a local or distributed rate-limit
    // denial) are control-plane verdicts, not provider failures. Keep this
    // outside the provider try/catch so they neither poison breaker state nor
    // trigger a cost-increasing failover attempt.
    await beforeAttempt?.(attempt, attemptNumber)

    try {
      const result = await execute(attempt, attemptNumber)
      registry?.recordProviderSuccess(attempt.provider)
      if (eventBus) {
        typedEmit(eventBus, {
          type: 'provider:run_selected',
          agentId,
          attempt: attemptNumber,
          provider: attempt.provider,
          model: attempt.modelName,
          phase,
          ...(runId !== undefined && { runId }),
          ...(tenantId !== undefined && { tenantId }),
        })
      }
      return result
    } catch (err) {
      lastError = err
      const asError = err instanceof Error ? err : new Error(String(err))
      if (isProviderFault && !isProviderFault(asError)) throw err
      registry?.recordProviderFailure(attempt.provider, asError)
      const retrying =
        index < attempts.length - 1 && shouldRetry(asError, index)
      if (eventBus) {
        typedEmit(eventBus, {
          type: 'provider:run_failure',
          agentId,
          attempt: attemptNumber,
          provider: attempt.provider,
          model: attempt.modelName,
          phase,
          reason: asError.message,
          retrying,
          ...(runId !== undefined && { runId }),
          ...(tenantId !== undefined && { tenantId }),
        })
      }
      if (!retrying) break
    }
  }

  throw lastError
}
