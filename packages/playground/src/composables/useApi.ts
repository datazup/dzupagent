/**
 * Composable for making typed API requests to the ForgeAgent server.
 *
 * Wraps `fetch` with JSON handling, error normalization, and base URL construction.
 *
 * @example
 * ```ts
 * const { get, post } = useApi()
 * const agents = await get<ApiResponse<AgentSummary[]>>('/api/agents')
 * ```
 */
import type { ApiError } from '../types.js'

/** Error thrown when an API request fails */
export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

interface RequestOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
}

/**
 * Build a full URL for an API endpoint.
 * In dev mode, Vite proxy handles `/api/*` -> server.
 * In production, assets are served alongside the API.
 */
export function buildUrl(path: string): string {
  // Ensure path starts with /
  const normalized = path.startsWith('/') ? path : `/${path}`
  return normalized
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let code = 'UNKNOWN_ERROR'
    let message = `Request failed with status ${response.status}`

    try {
      const body = (await response.json()) as ApiError
      if (body.error) {
        code = body.error.code
        message = body.error.message
      }
    } catch {
      // Response body is not JSON — use defaults
    }

    throw new ApiRequestError(response.status, code, message)
  }

  return response.json() as Promise<T>
}

export function useApi() {
  async function get<T>(path: string, options?: RequestOptions): Promise<T> {
    const url = buildUrl(path)
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      signal: options?.signal,
    })
    return handleResponse<T>(response)
  }

  async function post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    const url = buildUrl(path)
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    return handleResponse<T>(response)
  }

  async function patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    const url = buildUrl(path)
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    return handleResponse<T>(response)
  }

  async function del<T>(path: string, options?: RequestOptions): Promise<T> {
    const url = buildUrl(path)
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      signal: options?.signal,
    })
    return handleResponse<T>(response)
  }

  return { get, post, patch, del, buildUrl }
}
