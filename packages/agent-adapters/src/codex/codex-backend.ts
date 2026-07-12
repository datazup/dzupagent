import type { AgentCLIAdapter } from '../types.js'
import { CodexAdapter, type CodexAdapterConfig } from './codex-adapter.js'
import { CodexCliAdapter, type CodexCliAdapterConfig } from './codex-cli-adapter.js'

export type CodexBackendConfig =
  | ({ backend?: 'sdk' | undefined } & CodexAdapterConfig)
  | ({ backend: 'cli' } & CodexCliAdapterConfig)

/** Materializes exactly the requested Codex backend; it never falls back. */
export function createCodexBackendAdapter(config: CodexBackendConfig = {}): AgentCLIAdapter {
  const { backend, ...adapterConfig } = config
  return backend === 'cli'
    ? new CodexCliAdapter(adapterConfig)
    : new CodexAdapter(adapterConfig)
}
