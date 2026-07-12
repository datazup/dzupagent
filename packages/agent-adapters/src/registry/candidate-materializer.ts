import type {
  ExecutionRouteCandidate,
  LocalModelCapabilityProfile,
} from '@dzupagent/runtime-contracts'

import type { AdapterProviderId, AgentCLIAdapter } from '../types.js'

export interface CandidateMaterializationDescriptor extends Omit<ExecutionRouteCandidate, 'health' | 'capabilities' | 'modelAvailable'> {
  provider: AdapterProviderId
  capabilities?: readonly string[]
}

type LocalModelInspector = AgentCLIAdapter & {
  listModels(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>>
  inspectModel(model: string, signal?: AbortSignal): Promise<{ capabilities: LocalModelCapabilityProfile }>
}

/** Materialize dynamic adapter health and Ollama model evidence before selection. */
export async function materializeRoutingCandidates(
  descriptors: readonly CandidateMaterializationDescriptor[],
  adapters: ReadonlyMap<AdapterProviderId, AgentCLIAdapter>,
  signal?: AbortSignal,
): Promise<ExecutionRouteCandidate[]> {
  return await Promise.all(descriptors.map(async (descriptor) => {
    const adapter = adapters.get(descriptor.provider)
    if (!adapter) {
      return {
        ...descriptor,
        backendAvailable: false,
        health: { status: 'unhealthy' as const, reason: 'Adapter is not registered' },
      }
    }

    const health = await adapter.healthCheck()
    const base: ExecutionRouteCandidate = {
      ...descriptor,
      backendAvailable: true,
      health: {
        status: health.healthy ? 'healthy' : 'unhealthy',
        reason: health.lastError,
      },
      capabilities: mergeCapabilities(descriptor.capabilities, adapterCapabilities(adapter)),
    }
    if (descriptor.provider !== 'ollama' || !isLocalModelInspector(adapter) || !descriptor.model) return base

    try {
      const models = await adapter.listModels(signal)
      const modelAvailable = models.some((model) => model.id === descriptor.model || model.name === descriptor.model)
      if (!modelAvailable) return { ...base, modelAvailable: false }
      const inspection = await adapter.inspectModel(descriptor.model, signal)
      return {
        ...base,
        modelAvailable: true,
        capabilities: mergeCapabilities(base.capabilities, localModelCapabilities(inspection.capabilities)),
      }
    } catch (error) {
      return {
        ...base,
        modelAvailable: false,
        health: { status: 'unhealthy', reason: error instanceof Error ? error.message : String(error) },
      }
    }
  }))
}

function isLocalModelInspector(adapter: AgentCLIAdapter): adapter is LocalModelInspector {
  const value = adapter as Partial<LocalModelInspector>
  return typeof value.listModels === 'function' && typeof value.inspectModel === 'function'
}

function adapterCapabilities(adapter: AgentCLIAdapter): string[] {
  const capabilities = adapter.getCapabilities()
  return Object.entries(capabilities)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name)
}

function localModelCapabilities(profile: LocalModelCapabilityProfile): string[] {
  return Object.entries(profile)
    .filter(([, value]) => value === true || (typeof value === 'number' && value > 0))
    .map(([name]) => name)
}

function mergeCapabilities(...values: Array<readonly string[] | undefined>): string[] {
  return [...new Set(values.flatMap((value) => value ?? []))].sort()
}
