import type { LlmAuditSink } from '@dzupagent/core/events'
import type {
  LocalModelCapabilityProfile,
  LocalModelEndpointDescriptor,
  LocalModelInventoryEntry,
  LocalModelProtocol,
} from '@dzupagent/runtime-contracts'
import type { AdapterConfig } from '../types.js'

export interface OllamaAdapterConfig extends AdapterConfig {
  /** Defaults to http://127.0.0.1:11434. */
  baseURL?: string | undefined
  /** Native Ollama is canonical; local OpenAI compatibility is explicit. */
  protocol?: LocalModelProtocol | undefined
  /** Defaults to true. Arbitrary public endpoints remain forbidden either way. */
  localOnly?: boolean | undefined
  /** Exact additional operator-approved local/private host or host:port entries. */
  approvedLocalHosts?: readonly string[] | undefined
  /** Required evidence for capabilities not discoverable through OpenAI compatibility. */
  declaredModelCapabilities?: Readonly<Record<string, Partial<LocalModelCapabilityProfile>>> | undefined
  /** Optional bearer credential for an approved local compatibility gateway. */
  apiKey?: string | undefined
  /** Total response body limit. Defaults to 8 MiB. */
  maxResponseBytes?: number | undefined
  /** Per-stream-record limit. Defaults to 1 MiB. */
  maxRecordBytes?: number | undefined
  /** Maximum streamed records. Defaults to 100,000. */
  maxRecords?: number | undefined
  /** Test seam; production uses the shared redirect-safe secure fetch path. */
  fetchImpl?: typeof fetch | undefined
  auditSink?: LlmAuditSink | undefined
  auditRunId?: string | undefined
  auditTenantId?: string | undefined
}

export interface ResolvedLocalModelEndpoint extends LocalModelEndpointDescriptor {
  readonly url: URL
  readonly allowedHosts: readonly string[]
}

export interface OllamaShowResponse {
  capabilities?: string[]
  model_info?: Record<string, unknown>
  details?: {
    family?: string
    families?: string[]
    parameter_size?: string
    quantization_level?: string
  }
}

export interface OllamaChatChunk {
  model?: string
  message?: {
    role?: string
    content?: string
    thinking?: string
    tool_calls?: Array<{
      function?: { name?: string; arguments?: unknown }
    }>
  }
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  total_duration?: number
}

export interface LocalModelInspection {
  readonly model: LocalModelInventoryEntry
  readonly capabilities: LocalModelCapabilityProfile
}
