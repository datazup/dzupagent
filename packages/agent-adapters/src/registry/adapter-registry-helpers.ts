/**
 * Helpers for {@link ProviderAdapterRegistry.executeWithFallback}.
 *
 * These functions are extracted to keep the orchestrator method readable.
 * They are intentionally pure — they neither emit on the event bus nor
 * touch circuit breaker state. The registry method remains responsible
 * for bookkeeping (`recordSuccess` / `recordFailure`) and bus emission so
 * the side-effect surface stays in one place.
 */

import { ForgeError } from '@dzupagent/core/advanced'

import type {
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
  RoutingDecision,
  TaskDescriptor,
  TokenUsage,
} from '../types.js'

function isProviderRawStreamEvent(
  event: AgentStreamEvent,
): event is Extract<AgentStreamEvent, { type: 'adapter:provider_raw' }> {
  return event.type === 'adapter:provider_raw'
}

/**
 * Outcome of running a single adapter attempt. Either the adapter
 * emitted `adapter:completed` (success) or it terminated without one
 * (failure — synthesised reason).
 */
export type AttemptOutcome =
  | {
      kind: 'success'
      usage?: TokenUsage | undefined
    }
  | {
      kind: 'failure'
      message: string
      code: string
      /** True if the adapter itself emitted an `adapter:failed` event. */
      sawFailedEvent: boolean
    }

/**
 * Setup a per-attempt AbortController layered on top of the caller's
 * abort signal, optionally with a timeout that aborts when exceeded.
 *
 * Returns:
 *  - `controller` — abort this when the attempt finishes / on timeout
 *  - `timeoutHandle` — the timer (caller must `clearTimeout` in finally)
 *  - `getDidTimeout` — closure flag set to true if the timeout fired
 */
export function setupAttemptTimeout(
  timeoutMs: number | undefined,
  baseSignal: AbortSignal | undefined,
): {
  controller: AbortController
  timeoutHandle: ReturnType<typeof setTimeout> | null
  getDidTimeout: () => boolean
} {
  const controller = new AbortController()
  if (baseSignal) {
    if (baseSignal.aborted) controller.abort()
    else baseSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  let didTimeout = false
  const timeoutEnabled = typeof timeoutMs === 'number' && timeoutMs > 0
  const timeoutHandle = timeoutEnabled
    ? setTimeout(() => {
        didTimeout = true
        controller.abort()
      }, timeoutMs as number)
    : null

  return {
    controller,
    timeoutHandle,
    getDidTimeout: () => didTimeout,
  }
}

/**
 * Run a single adapter attempt and yield its events. Pure with respect to
 * registry state — the caller is responsible for circuit breaker bookkeeping
 * and event-bus emissions based on the returned {@link AttemptOutcome}.
 *
 * Yields:
 *  - all adapter events (including raw provider streams) verbatim
 *  - on stream end without `adapter:completed`, a synthesised
 *    `adapter:failed` event so downstream observers see a terminal signal
 *
 * Returns the classified outcome via the generator's return value.
 */
export async function* runOneAttempt(
  adapter: AgentCLIAdapter,
  input: AgentInput,
  providerId: AdapterProviderId,
  effectiveTimeoutMs: number | undefined,
  getDidTimeout: () => boolean,
): AsyncGenerator<AgentStreamEvent, AttemptOutcome, undefined> {
  let sawCompleted = false
  let sawFailed = false
  let lastFailedEvent: Extract<AgentEvent, { type: 'adapter:failed' }> | undefined
  let completedUsage: TokenUsage | undefined

  const gen = adapter.executeWithRaw?.(input) ?? adapter.execute(input)

  for await (const event of gen) {
    if (isProviderRawStreamEvent(event)) {
      yield event
      continue
    }
    if (event.type === 'adapter:completed') {
      sawCompleted = true
      // Preserve token usage surfaced by the adapter so downstream
      // bus listeners (metrics, cost attribution, relay aggregators)
      // can observe real token counts instead of falling back to zero.
      if (event.usage) completedUsage = event.usage
    } else if (event.type === 'adapter:failed') {
      sawFailed = true
      lastFailedEvent = event
    }
    yield event
  }

  if (sawCompleted) {
    return { kind: 'success', usage: completedUsage }
  }

  const didTimeout = getDidTimeout()
  const message = didTimeout
    ? `Adapter ${providerId} exceeded registry timeout of ${effectiveTimeoutMs}ms`
    : sawFailed
      ? (lastFailedEvent?.error ?? 'Adapter emitted failure event without details')
      : 'Adapter stream ended without terminal adapter:completed event'
  const code = didTimeout
    ? 'ADAPTER_TIMEOUT'
    : sawFailed
      ? (lastFailedEvent?.code ?? 'ADAPTER_EXECUTION_FAILED')
      : 'ADAPTER_EXECUTION_FAILED'

  // Synthesize a terminal failure event when the adapter never emitted one,
  // so downstream observers always receive a terminal signal per provider.
  if (!sawFailed) {
    yield {
      type: 'adapter:failed',
      providerId,
      error: message,
      code,
      timestamp: Date.now(),
    }
  }

  return { kind: 'failure', message, code, sawFailedEvent: sawFailed }
}

/**
 * Build the terminal `ALL_ADAPTERS_EXHAUSTED` ForgeError thrown when every
 * provider in the fallback chain failed.
 */
export function synthesizeFailureEvents(
  attempts: AdapterProviderId[],
  lastError: Error | undefined,
  task: TaskDescriptor,
): ForgeError {
  return new ForgeError({
    code: 'ALL_ADAPTERS_EXHAUSTED',
    message: `All adapters failed. Last error: ${lastError?.message ?? 'unknown'}`,
    recoverable: false,
    cause: lastError,
    suggestion: 'Check adapter health and circuit breaker states',
    context: {
      attemptedProviders: attempts,
      taskTags: task.tags,
    },
  })
}

/**
 * Resolve the per-execution timeout from input options or registry default.
 * Per-call options take precedence; falsy values disable the timeout.
 */
export function resolveTimeoutMs(
  input: AgentInput,
  defaultMs: number | undefined,
): number | undefined {
  const perCall = typeof input.options?.['timeoutMs'] === 'number'
    ? (input.options['timeoutMs'] as number)
    : undefined
  return perCall ?? defaultMs
}

/**
 * Build an `adapter:progress` event describing the registry's routing decision.
 * Emitted once per executeWithFallback call before the first attempt so callers
 * (NDJSON tail-f, dashboards, audit logs) can observe which provider was
 * selected and the full fallback chain.
 */
export function buildRoutingProgressEvent(args: {
  providerId: AdapterProviderId | undefined
  decision: RoutingDecision
  ordered: AdapterProviderId[]
  input: AgentInput
  message: string
}): Extract<AgentEvent, { type: 'adapter:progress' }> {
  const providerId = args.providerId ?? (args.ordered[0] as AdapterProviderId)
  return {
    type: 'adapter:progress',
    providerId,
    timestamp: Date.now(),
    phase: 'registry:routing',
    message: args.message,
    total: args.ordered.length,
    current: 0,
    ...(args.input.correlationId ? { correlationId: args.input.correlationId } : {}),
  }
}

/**
 * Build an `adapter:progress` event for a single fallback attempt.
 * `current` is 1-indexed within `total` so progress UIs render correctly.
 */
export function buildAttemptProgressEvent(args: {
  providerId: AdapterProviderId
  attemptIdx: number
  totalAttempts: number
  input: AgentInput
  message: string
}): Extract<AgentEvent, { type: 'adapter:progress' }> {
  return {
    type: 'adapter:progress',
    providerId: args.providerId,
    timestamp: Date.now(),
    phase: args.attemptIdx === 0 ? 'registry:primary_attempt' : 'registry:fallback_attempt',
    message: args.message,
    current: args.attemptIdx + 1,
    total: args.totalAttempts,
    ...(args.input.correlationId ? { correlationId: args.input.correlationId } : {}),
  }
}

/**
 * Build the fallback order: primary first, then fallbacks from the decision,
 * then any remaining healthy adapters not already listed.
 */
export function buildFallbackOrder(
  decision: RoutingDecision,
  healthyIds: AdapterProviderId[],
): AdapterProviderId[] {
  const ordered: AdapterProviderId[] = []
  const seen = new Set<AdapterProviderId>()

  const addUnique = (id: AdapterProviderId): void => {
    if (!seen.has(id) && healthyIds.includes(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }

  if (decision.provider !== 'auto') addUnique(decision.provider)
  if (decision.fallbackProviders) {
    for (const fb of decision.fallbackProviders) addUnique(fb)
  }
  for (const id of healthyIds) addUnique(id)
  return ordered
}

/**
 * Classification of an exception thrown during a single attempt.
 * `propagate` means the orchestrator should rethrow (e.g. AGENT_ABORTED
 * from a caller-initiated abort, not a timeout).
 */
export type AttemptErrorClassification =
  | { kind: 'propagate'; error: Error }
  | { kind: 'recover'; error: Error; code: string; message: string; failedEvent: Extract<AgentEvent, { type: 'adapter:failed' }> }

/**
 * Classify an error caught during a single adapter attempt.
 * AGENT_ABORTED that is NOT a registry timeout propagates upward.
 * All other errors yield a synthesised failure event so the fallback
 * chain can continue.
 */
export function classifyAttemptError(
  err: unknown,
  providerId: AdapterProviderId,
  effectiveTimeoutMs: number | undefined,
  didTimeout: boolean,
): AttemptErrorClassification {
  const error = err instanceof Error ? err : new Error(String(err))
  if (ForgeError.is(err) && err.code === 'AGENT_ABORTED' && !didTimeout) {
    return { kind: 'propagate', error: err }
  }

  const code = didTimeout ? 'ADAPTER_TIMEOUT' : 'ADAPTER_EXECUTION_FAILED'
  const message = didTimeout
    ? `Adapter ${providerId} exceeded registry timeout of ${effectiveTimeoutMs}ms`
    : error.message

  return {
    kind: 'recover',
    error,
    code,
    message,
    failedEvent: {
      type: 'adapter:failed',
      providerId,
      error: message,
      code,
      timestamp: Date.now(),
    },
  }
}
