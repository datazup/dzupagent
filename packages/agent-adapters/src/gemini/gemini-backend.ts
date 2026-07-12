import type { AgentCLIAdapter } from '../types.js'
import { GeminiCLIAdapter, type GeminiCliAdapterConfig } from './gemini-adapter.js'
import { GeminiSDKAdapter, type GeminiSDKAdapterConfig } from './gemini-sdk-adapter.js'

export type GeminiBackendConfig =
  | ({ backend?: 'cli' | undefined } & GeminiCliAdapterConfig)
  | ({ backend: 'sdk' } & GeminiSDKAdapterConfig)

/** Materializes exactly the requested Gemini backend; it never falls back. */
export function createGeminiBackendAdapter(config: GeminiBackendConfig = {}): AgentCLIAdapter {
  const { backend, ...adapterConfig } = config
  return backend === 'sdk'
    ? new GeminiSDKAdapter(adapterConfig)
    : new GeminiCLIAdapter(adapterConfig)
}
