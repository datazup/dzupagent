import { isIP } from 'node:net'
import { ForgeError } from '@dzupagent/core/events'
import type { LocalModelEndpointRejectionCode, LocalModelProtocol } from '@dzupagent/runtime-contracts'
import type { OllamaAdapterConfig, ResolvedLocalModelEndpoint } from './ollama-types.js'

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

export function resolveLocalModelEndpoint(config: OllamaAdapterConfig): ResolvedLocalModelEndpoint {
  const protocol: LocalModelProtocol = config.protocol ?? 'ollama'
  if (protocol !== 'ollama' && protocol !== 'openai-compatible') {
    throw endpointError('LOCAL_MODEL_PROTOCOL_UNSUPPORTED', `Unsupported local-model protocol: ${String(protocol)}`)
  }
  let url: URL
  try { url = new URL(config.baseURL ?? DEFAULT_OLLAMA_URL) } catch {
    throw endpointError('LOCAL_MODEL_URL_INVALID', 'Local-model base URL is invalid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw endpointError('LOCAL_MODEL_PROTOCOL_UNSUPPORTED', 'Local-model endpoint must use http or https')
  }
  if (url.username || url.password) throw endpointError('LOCAL_MODEL_ENDPOINT_HAS_CREDENTIALS', 'Local-model URL must not embed credentials')
  if (url.search || url.hash) throw endpointError('LOCAL_MODEL_ENDPOINT_HAS_QUERY', 'Local-model base URL must not contain query or fragment state')

  const hostname = normalizeHostname(url.hostname)
  const approved = new Set((config.approvedLocalHosts ?? []).map(normalizeHost).filter(Boolean))
  const hostApproved = approved.has(normalizeHost(url.host)) || approved.has(hostname)
  const loopback = isLoopbackHost(hostname)
  if (!loopback && !hostApproved) {
    const code: LocalModelEndpointRejectionCode = config.localOnly === false
      ? 'LOCAL_MODEL_ENDPOINT_NOT_APPROVED'
      : 'LOCAL_MODEL_ENDPOINT_NOT_LOCAL'
    throw endpointError(code, `Local-model endpoint is neither loopback nor explicitly approved: ${url.host}`)
  }
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/'
  return {
    backend: 'local-model',
    protocol,
    baseUrl: url.href.replace(/\/$/u, ''),
    localOnly: config.localOnly ?? true,
    approvedLocalHosts: [...approved],
    url,
    allowedHosts: [url.host],
  }
}

export function localEndpointUrl(endpoint: ResolvedLocalModelEndpoint, path: string): string {
  const base = endpoint.baseUrl.endsWith('/') ? endpoint.baseUrl : `${endpoint.baseUrl}/`
  return new URL(path.replace(/^\//u, ''), base).href
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1') return true
  if (isIP(hostname) !== 4) return false
  const first = Number(hostname.split('.')[0])
  return first === 127
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, '')
}

function endpointError(code: LocalModelEndpointRejectionCode, message: string): ForgeError {
  return new ForgeError({
    code: 'CAPABILITY_DENIED',
    message,
    recoverable: false,
    context: { providerId: 'ollama', backend: 'local-model', rejectionCode: code },
  })
}
