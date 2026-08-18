import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentCircuitBreaker } from './circuit-breaker.js'
import { recordCircuitBreakerFailure } from './circuit-breaker-recorder.js'
import type {
  SpecialistInvocationObserver,
  SpecialistInvocationOutcome,
} from './supervisor-types.js'

export interface SpecialistToolInstrumentation {
  /** Allocate the next run-local invocation index immediately before start. */
  nextInvocationIndex(): number
  /** Best-effort observer for start and completion evidence. */
  observer: SpecialistInvocationObserver
}

export function instrumentSpecialistTool(
  tool: StructuredToolInterface,
  specialistId: string,
  circuitBreaker: AgentCircuitBreaker | undefined,
  instrumentation?: SpecialistToolInstrumentation,
): StructuredToolInterface {
  if (!circuitBreaker && !instrumentation) return tool

  const originalInvoke = tool.invoke.bind(tool)
  const wrappedInvoke = (async (...args: Parameters<typeof tool.invoke>) => {
    const observer = instrumentation?.observer
    const invocationIndex = instrumentation?.nextInvocationIndex()
    if (invocationIndex !== undefined && observer) {
      notifyBestEffort(observer.onStart, {
        specialistId,
        invocationIndex,
      })
    }
    const startedAt = Date.now()

    try {
      const result = await originalInvoke(...args)
      if (invocationIndex !== undefined && observer) {
        notifyBestEffort(observer.onComplete, {
          specialistId,
          invocationIndex,
          success: true,
          durationMs: elapsedSince(startedAt),
        })
      }
      circuitBreaker?.recordSuccess(specialistId)
      return result
    } catch (err: unknown) {
      if (invocationIndex !== undefined && observer) {
        notifyBestEffort(observer.onComplete, {
          specialistId,
          invocationIndex,
          success: false,
          durationMs: elapsedSince(startedAt),
          error: normalizeError(err),
        })
      }
      if (circuitBreaker) {
        recordCircuitBreakerFailure(circuitBreaker, specialistId, err)
      }
      throw err
    }
  }) as typeof tool.invoke

  // Return a shallow clone with a patched `invoke` rather than mutating the
  // shared tool instance. Mutation would race when the same tool object is
  // used by multiple parallel specialist calls.
  const wrapped = Object.create(
    Object.getPrototypeOf(tool) as object,
    Object.getOwnPropertyDescriptors(tool),
  ) as StructuredToolInterface
  Object.defineProperty(wrapped, 'invoke', {
    value: wrappedInvoke,
    writable: true,
    configurable: true,
    enumerable: true,
  })
  return wrapped
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Invoke a possibly-async callback without letting it affect tool control flow. */
function notifyBestEffort<T extends SpecialistInvocationOutcome | {
  specialistId: string
  invocationIndex: number
}>(callback: ((value: T) => unknown) | undefined, value: T): void {
  if (!callback) return
  try {
    const result = callback(value)
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result
    ) {
      void Promise.resolve(result).catch(() => {})
    }
  } catch {
    // Invocation observation is evidence-only and must never alter execution.
  }
}
