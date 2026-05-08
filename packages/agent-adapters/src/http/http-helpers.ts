/**
 * Internal helpers for AdapterHttpHandler.
 *
 * Pure functions for response shaping, header parsing, path parameter
 * extraction, and provider-id resolution. Kept separate from the handler
 * class so they can be unit-tested in isolation and reused.
 */

import type { AdapterProviderId } from '../types.js'
import { resolveFallbackProviderId } from '../utils/provider-helpers.js'
import type { HttpResponse } from './http-types.js'

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

export function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body,
  }
}

export function errorResponse(status: number, message: string, code?: string): HttpResponse {
  return jsonResponse(status, { error: message, code })
}

// ---------------------------------------------------------------------------
// Provider-id resolution
// ---------------------------------------------------------------------------

export function collectProviderIds(
  entries:
    | Array<{ providerId?: AdapterProviderId | null }>
    | undefined,
): AdapterProviderId[] {
  if (!entries) return []

  const providerIds: AdapterProviderId[] = []
  for (const entry of entries) {
    const providerId = entry.providerId
    if (providerId) {
      providerIds.push(providerId)
    }
  }

  return providerIds
}

export function resolveRuntimeFallbackProviderId(
  registry: { listAdapters(): AdapterProviderId[] },
  preferredProvider?: AdapterProviderId,
  providers?: AdapterProviderId[],
): AdapterProviderId {
  return preferredProvider
    ?? providers?.[0]
    ?? resolveFallbackProviderId(registry.listAdapters())
    ?? ('unknown' as AdapterProviderId)
}

export function resolveStreamCompletionProviderId(
  registry: { listAdapters(): AdapterProviderId[] },
  completion: {
    providerId?: AdapterProviderId | null
    selectedResult?: { providerId?: AdapterProviderId | null }
    subtaskResults?: Array<{ providerId?: AdapterProviderId | null }>
  },
  fallbackProviders?: AdapterProviderId[],
): AdapterProviderId {
  const actualProviderId =
    completion.selectedResult?.providerId
    ?? completion.providerId

  const providers = fallbackProviders ?? collectProviderIds(completion.subtaskResults)

  return resolveRuntimeFallbackProviderId(
    registry,
    actualProviderId ?? undefined,
    providers,
  )
}

// ---------------------------------------------------------------------------
// Header / path parsing
// ---------------------------------------------------------------------------

/**
 * Extract a correlation ID from standard HTTP headers.
 *
 * Checks (in priority order):
 *  1. `x-correlation-id`
 *  2. `x-request-id`
 *  3. W3C `traceparent` trace-id segment
 */
export function extractCorrelationId(
  headers: Record<string, string | undefined>,
): string | undefined {
  const explicit = headers['x-correlation-id'] ?? headers['x-request-id']
  if (explicit) return explicit

  const traceparent = headers['traceparent']
  if (traceparent) {
    // W3C traceparent format: version-traceId-parentId-flags
    const segments = traceparent.split('-')
    if (segments.length >= 2 && segments[1]!.length > 0) {
      return segments[1]
    }
  }

  return undefined
}

/**
 * Extract a path parameter from a pattern like "/approve/:id".
 * Returns the captured segment or undefined.
 */
export function matchPathParam(
  actualPath: string,
  prefix: string,
): string | undefined {
  const normalised = actualPath.startsWith('/') ? actualPath : `/${actualPath}`
  if (!normalised.startsWith(prefix)) return undefined
  const rest = normalised.slice(prefix.length)
  // Must have exactly one segment remaining (e.g. "/abc123")
  if (!rest.startsWith('/') || rest.indexOf('/', 1) !== -1) return undefined
  const param = rest.slice(1)
  return param.length > 0 ? param : undefined
}
