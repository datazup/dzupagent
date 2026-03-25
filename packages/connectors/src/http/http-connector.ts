/**
 * HTTP connector — generic REST API tool.
 *
 * Makes arbitrary HTTP requests to a configured base URL.
 * Useful for integrating with any REST API.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'

export interface HTTPConnectorConfig {
  /** Base URL for all requests */
  baseUrl: string
  /** Default headers to include */
  headers?: Record<string, string>
  /** Allowed HTTP methods (default: all) */
  allowedMethods?: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>
  /** Request timeout in ms (default: 30_000) */
  timeoutMs?: number
}

export function createHTTPConnector(config: HTTPConnectorConfig): DynamicStructuredTool[] {
  const methods = config.allowedMethods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

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

        const url = new URL(path, config.baseUrl)
        if (query) {
          for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000)

        try {
          const res = await fetch(url.toString(), {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...config.headers,
            },
            body: body ?? undefined,
            signal: controller.signal,
          })

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
