import type { AgentCLIAdapter } from '../types.js'
import { ClaudeAgentAdapter, type ClaudeAdapterConfig } from './claude-adapter.js'
import { ClaudeCliAdapter, type ClaudeCliAdapterConfig } from './claude-cli-adapter.js'

export type ClaudeBackendConfig =
  | ({ backend: 'sdk' } & ClaudeAdapterConfig)
  | ({ backend: 'cli' } & ClaudeCliAdapterConfig)

/** Materializes exactly the requested Claude backend; it never falls back. */
export function createClaudeBackendAdapter(config: ClaudeBackendConfig): AgentCLIAdapter {
  const { backend, ...adapterConfig } = config
  return backend === 'cli'
    ? new ClaudeCliAdapter(adapterConfig)
    : new ClaudeAgentAdapter(adapterConfig)
}

