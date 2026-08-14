import type { AgentCLIAdapter } from '../types.js'
import { CodexAdapter, type CodexAdapterConfig } from './codex-adapter.js'
import {
  CodexAppServerAdapter,
  type CodexAppServerAdapterOptions,
} from './codex-app-server-adapter.js'
import { CodexCliAdapter, type CodexCliAdapterConfig } from './codex-cli-adapter.js'

export type CodexBackendConfig =
  | ({ backend?: 'sdk' | undefined } & CodexAdapterConfig)
  | ({ backend: 'cli' } & CodexCliAdapterConfig)
  | ({ backend: 'app-server' } & CodexAppServerAdapterOptions)

/** Materializes exactly the requested Codex backend; it never falls back. */
export function createCodexBackendAdapter(config: CodexBackendConfig = {}): AgentCLIAdapter {
  if (config.backend === 'cli') {
    const { backend: _backend, ...adapterConfig } = config
    return new CodexCliAdapter(adapterConfig)
  }
  if (config.backend === 'app-server') {
    const { backend: _backend, ...adapterConfig } = config
    return new CodexAppServerAdapter(adapterConfig)
  }
  const { backend: _backend, ...adapterConfig } = config
  return new CodexAdapter(adapterConfig)
}
