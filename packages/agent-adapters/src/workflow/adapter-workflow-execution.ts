import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentFailedEvent,
} from '../types.js'
import { WorkflowStepResolver, type TemplateContext } from './template-resolver.js'
import type {
  AdapterStepResult,
  ParallelMergeStrategy,
} from './adapter-workflow.js'

export const sharedTemplateResolver = new WorkflowStepResolver()

export function resolveFallbackProviderId(
  registry: ProviderAdapterRegistry,
  preferredProvider?: AdapterProviderId,
): AdapterProviderId {
  return preferredProvider ?? registry.listAdapters()[0] ?? ('unknown' as AdapterProviderId)
}

export function resolveTemplate(
  template: string,
  state: Record<string, unknown>,
  prevResult?: string,
): string {
  const context: TemplateContext = { prev: prevResult, state }
  return sharedTemplateResolver.resolve(template, context)
}

export function isCompletedEvent(event: AgentEvent): event is AgentCompletedEvent {
  return event.type === 'adapter:completed'
}

export function isFailedEvent(event: AgentEvent): event is AgentFailedEvent {
  return event.type === 'adapter:failed'
}

export function mergeParallelResults(
  state: Record<string, unknown>,
  results: AdapterStepResult[],
  strategy: ParallelMergeStrategy,
): void {
  switch (strategy) {
    case 'merge': {
      for (const result of results) {
        state[result.stepId] = result.result
      }
      break
    }
    case 'concat': {
      state['parallelResults'] = results.map((r) => ({
        stepId: r.stepId,
        result: r.result,
        success: r.success,
      }))
      for (const result of results) {
        state[result.stepId] = result.result
      }
      break
    }
    case 'last-wins': {
      const lastSuccess = [...results].reverse().find((r) => r.success)
      if (lastSuccess) {
        state['lastResult'] = lastSuccess.result
      }
      for (const result of results) {
        state[result.stepId] = result.result
      }
      break
    }
  }
}
