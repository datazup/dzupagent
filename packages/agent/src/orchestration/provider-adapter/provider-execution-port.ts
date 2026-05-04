/**
 * ProviderExecutionPort — historical re-export shim.
 *
 * The canonical definition lives in `@dzupagent/adapter-types`
 * (a layer-0 type-only package). Neither `@dzupagent/agent` nor
 * `@dzupagent/agent-adapters` owns this contract.
 *
 * This file exists to preserve the historical import path
 * `@dzupagent/agent/orchestration/provider-adapter/provider-execution-port`
 * for backwards compatibility. New code should import directly from
 * `@dzupagent/adapter-types`.
 */
export type {
  ProviderExecutionPort,
  ProviderExecutionResult,
  AgentInput,
  AgentEvent,
  TaskDescriptor,
  AdapterProviderId,
} from '@dzupagent/adapter-types'
