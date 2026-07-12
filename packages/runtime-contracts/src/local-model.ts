/** Canonical direct local-model endpoint, inventory, and capability contracts. */

export type LocalModelProtocol = 'ollama' | 'openai-compatible'

export type LocalModelEndpointRejectionCode =
  | 'LOCAL_MODEL_URL_INVALID'
  | 'LOCAL_MODEL_PROTOCOL_UNSUPPORTED'
  | 'LOCAL_MODEL_ENDPOINT_NOT_LOCAL'
  | 'LOCAL_MODEL_ENDPOINT_NOT_APPROVED'
  | 'LOCAL_MODEL_ENDPOINT_HAS_CREDENTIALS'
  | 'LOCAL_MODEL_ENDPOINT_HAS_QUERY'

export interface LocalModelEndpointDescriptor {
  readonly backend: 'local-model'
  readonly protocol: LocalModelProtocol
  readonly baseUrl: string
  /** Defaults to true. Arbitrary public endpoints are never accepted. */
  readonly localOnly?: boolean
  /** Exact operator-approved local/private host or host:port entries. */
  readonly approvedLocalHosts?: readonly string[]
}

export interface LocalModelCapabilityProfile {
  readonly text: boolean
  readonly vision: boolean
  readonly tools: boolean
  readonly structuredOutput: boolean
  readonly thinking: boolean
  readonly embedding: boolean
  readonly contextTokens?: number
  readonly evidence: 'ollama-show' | 'operator-declared'
}

export interface LocalModelInventoryEntry {
  readonly id: string
  readonly name: string
  readonly digest?: string
  readonly modifiedAt?: string
  readonly sizeBytes?: number
  readonly family?: string
  readonly parameterSize?: string
  readonly quantizationLevel?: string
  readonly capabilities?: LocalModelCapabilityProfile
}

export interface LocalModelHealthSnapshot {
  readonly healthy: boolean
  readonly endpoint: string
  readonly protocol: LocalModelProtocol
  readonly modelCount?: number
  readonly checkedAt: string
  readonly errorCode?: string
}
