/**
 * HTTP connector — generic REST API tool.
 *
 * Makes arbitrary HTTP requests to a configured base URL.
 * Useful for integrating with any REST API.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { fetchWithOutboundUrlPolicy, type OutboundUrlSecurityPolicy } from '@dzupagent/core/security'
import type { ConnectorToolkit } from '../connector-contract.js'

export interface HTTPConnectorConfig {
  /** Base URL for all requests */
  baseUrl: string
  /** Default headers to include */
  headers?: Record<string, string>
  /** Allowed HTTP methods (default: all) */
  allowedMethods?: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>
  /** Request timeout in ms (default: 30_000) */
  timeoutMs?: number
  /** Additional hosts this connector profile may reach, including redirects. */
  allowedHosts?: string[]
  /** Optional low-level outbound URL policy overrides for trusted deployments and tests. */
  outboundUrlPolicy?: OutboundUrlSecurityPolicy
}

function parseHttpBaseUrl(baseUrl: string): URL {
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`HTTP connector baseUrl protocol must be http or https, got "${parsed.protocol}".`)
  }
  if (!parsed.hostname) {
    throw new Error('HTTP connector baseUrl host is required.')
  }
  return parsed
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

function normalizeHostname(value: string): string {
  return normalizeHost(value).replace(/^\[|\]$/g, '')
}

function toHostList(value: OutboundUrlSecurityPolicy['allowedHosts']): string[] {
  if (!value) return []
  return Array.from(value)
}

function hostMatches(candidate: URL, allowedHosts: Set<string>): boolean {
  const hostname = normalizeHostname(candidate.hostname)
  const host = normalizeHost(candidate.host)
  return allowedHosts.has(hostname) || allowedHosts.has(host)
}

function createHttpConnectorPolicy(
  base: URL,
  config: HTTPConnectorConfig,
): {
  policy: OutboundUrlSecurityPolicy
  fetchImpl: typeof fetch
} {
  const explicitAllowedHosts = new Set((config.allowedHosts ?? []).map(normalizeHost).filter(Boolean))
  const policyAllowedHosts = new Set<string>([
    normalizeHostname(base.hostname),
    normalizeHost(base.host),
    ...explicitAllowedHosts,
    ...toHostList(config.outboundUrlPolicy?.allowedHosts).map(normalizeHost).filter(Boolean),
  ])
  const policy: OutboundUrlSecurityPolicy = {
    ...config.outboundUrlPolicy,
    allowedHosts: policyAllowedHosts,
    allowHttp: config.outboundUrlPolicy?.allowHttp === true || base.protocol === 'http:',
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const nextUrl = new URL(String(input))
    if (nextUrl.origin !== base.origin && !hostMatches(nextUrl, explicitAllowedHosts)) {
      throw new Error(
        `URL origin "${nextUrl.origin}" does not match base origin "${base.origin}" and is not in the connector host allowlist.`,
      )
    }
    // eslint-disable-next-line no-restricted-globals -- intentional: HTTP connector primitive that has already enforced origin/host allowlist above
    return fetch(input, init)
  }

  return { policy, fetchImpl }
}

export function createHTTPConnector(config: HTTPConnectorConfig): DynamicStructuredTool[] {
  const methods = config.allowedMethods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
  const base = parseHttpBaseUrl(config.baseUrl)
  const { policy, fetchImpl } = createHttpConnectorPolicy(base, config)

  return [
    new DynamicStructuredTool({
      name: 'http_request',
      description: `Make HTTP requests to ${config.baseUrl}. Allowed methods: ${methods.join(', ')}`,
      schema: z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method'),
        path: z.string().describe('URL path (appended to base URL)'),
        body: z.string().optional().describe('Request body as JSON string (for POST/PUT/PATCH)'),
        query: z.record(z.string(), z.string()).optional().describe('Query parameters'),
      }),
      func: async ({ method, path, body, query }) => {
        if (!methods.includes(method as 'GET')) {
          return `Error: Method ${method} not allowed. Allowed: ${methods.join(', ')}`
        }

        const url = new URL(path, base)

        // Prevent SSRF: reject paths that escape the configured base origin
        if (url.origin !== base.origin) {
          return `Error: URL origin "${url.origin}" does not match base origin "${base.origin}". Absolute URLs are not allowed.`
        }

        if (query) {
          for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000)

        try {
          const res = await fetchWithOutboundUrlPolicy(
            url.toString(),
            {
              method,
              headers: {
                'Content-Type': 'application/json',
                ...config.headers,
              },
              body: body ?? undefined,
              signal: controller.signal,
            },
            { policy, fetchImpl },
          )

          const text = await res.text()
          return `${res.status} ${res.statusText}\n\n${text.slice(0, 5000)}`
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        } finally {
          clearTimeout(timeout)
        }
      },
    }),
  ]
}

/**
 * Create a ConnectorToolkit for generic HTTP operations.
 * Wraps `createHTTPConnector` in the unified toolkit pattern.
 */
export function createHttpConnectorToolkit(config: HTTPConnectorConfig): ConnectorToolkit {
  return {
    name: 'http',
    tools: createHTTPConnector(config),
  }
}
