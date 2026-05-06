import type { StructuredToolInterface } from '@langchain/core/tools'
import type { AgentCircuitBreaker } from './circuit-breaker.js'
import { recordCircuitBreakerFailure } from './circuit-breaker-recorder.js'

export function instrumentSpecialistTool(
  tool: StructuredToolInterface,
  specialistId: string,
  circuitBreaker: AgentCircuitBreaker | undefined,
): StructuredToolInterface {
  if (!circuitBreaker) return tool

  const originalInvoke = tool.invoke.bind(tool)
  const wrappedInvoke = (async (...args: Parameters<typeof tool.invoke>) => {
    try {
      const result = await originalInvoke(...args)
      circuitBreaker.recordSuccess(specialistId)
      return result
    } catch (err: unknown) {
      recordCircuitBreakerFailure(circuitBreaker, specialistId, err)
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
