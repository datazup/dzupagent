/**
 * Forge URI scheme — identity URIs for DzupAgent agents.
 *
 * Format: `forge://<organization>/<agent-name>(@<semver>)?`
 *
 * For message routing URIs that may use a2a://, mcp://, etc., use
 * ForgeMessageUriSchema instead (defined in the messaging module).
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// URI regex
// ---------------------------------------------------------------------------

/**
 * Matches `forge://org/name` or `forge://org/name@1.2.3`.
 * Organization and agent name allow lowercase letters, digits, underscores, hyphens.
 */
// eslint-disable-next-line security/detect-unsafe-regex
const DZIP_URI_REGEX = /^forge:\/\/[a-z0-9_-]+\/[a-z0-9_-]+(@\d+\.\d+\.\d+)?$/

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for validating identity URIs.
 *
 * For message routing URIs that may use a2a://, mcp://, etc., use
 * ForgeMessageUriSchema instead.
 */
export const ForgeUriSchema = z.string().regex(DZIP_URI_REGEX, {
  message:
    'Invalid Forge URI. Expected format: forge://<org>/<name> or forge://<org>/<name>@<semver>',
})

// ---------------------------------------------------------------------------
// Parse result
// ---------------------------------------------------------------------------

export interface ParsedForgeUri {
  organization: string
  agentName: string
  version?: string
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Parse a `forge://` URI into its constituent parts.
 * Throws if the URI is malformed.
 */
export function parseForgeUri(uri: string): ParsedForgeUri {
  const validated = ForgeUriSchema.parse(uri)
  const withoutScheme = validated.slice('forge://'.length)

  const slashIdx = withoutScheme.indexOf('/')
  const organization = withoutScheme.slice(0, slashIdx)
  const rest = withoutScheme.slice(slashIdx + 1)

  const atIdx = rest.indexOf('@')
  if (atIdx === -1) {
    return { organization, agentName: rest }
  }
  return {
    organization,
    agentName: rest.slice(0, atIdx),
    version: rest.slice(atIdx + 1),
  }
}

/**
 * Build a `forge://` URI from parts.
 */
export function buildForgeUri(org: string, name: string, version?: string): string {
  const uri = version ? `forge://${org}/${name}@${version}` : `forge://${org}/${name}`
  // Validate the result
  ForgeUriSchema.parse(uri)
  return uri
}

/**
 * Check if a string is a valid Forge URI. Never throws.
 */
export function isForgeUri(value: string): boolean {
  return DZIP_URI_REGEX.test(value)
}

/**
 * Convert a `forge://` URI to an `agent://` URI (same structure, different scheme).
 * Throws if the input is not a valid Forge URI.
 */
export function toAgentUri(forgeUri: string): string {
  ForgeUriSchema.parse(forgeUri)
  return 'agent://' + forgeUri.slice('forge://'.length)
}

/**
 * Convert an `agent://` URI back to a `forge://` URI.
 * Throws if the result would not be a valid Forge URI.
 */
export function fromAgentUri(agentUri: string): string {
  if (!agentUri.startsWith('agent://')) {
    throw new Error(`Expected agent:// URI, got: ${agentUri}`)
  }
  const forgeUri = 'forge://' + agentUri.slice('agent://'.length)
  ForgeUriSchema.parse(forgeUri)
  return forgeUri
}

// ---------------------------------------------------------------------------
// URI Resolver
// ---------------------------------------------------------------------------

/** Strategy for resolving Forge URIs to endpoint URLs. */
export type UriResolverStrategy = 'static' | 'convention' | 'registry'

/** Resolves a Forge URI to an endpoint URL (or null if not found). */
export interface UriResolver {
  resolve(uri: string): Promise<string | null>
}

/** Configuration for URI resolver creation. */
export interface UriResolverConfig {
  /** For 'static' strategy: map of URI -> endpoint URL. */
  staticMap?: Record<string, string>
  /** For 'convention' strategy: base URL template with {org} and {name} placeholders; also used as registry fallback when provided. */
  urlTemplate?: string
  /** For 'registry' strategy: registry endpoint URL. */
  registryUrl?: string
  /** Timeout in milliseconds for each registry lookup attempt. */
  timeoutMs?: number
  /** Maximum number of retries after the initial registry lookup attempt. */
  maxRetries?: number
  /** Optional fetch implementation for registry lookups. */
  fetchImpl?: RegistryFetch
}

interface RegistryFetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

type RegistryFetch = (input: string, init?: { signal?: AbortSignal }) => Promise<RegistryFetchResponse>

type RegistryLookupResult =
  | { kind: 'resolved'; endpoint: string }
  | { kind: 'not_found' }
  | { kind: 'retryable'; reason: 'timeout' | 'network' }
  | { kind: 'terminal' }

const DEFAULT_REGISTRY_TIMEOUT_MS = 5_000
const DEFAULT_REGISTRY_RETRIES = 1

/**
 * Create a URI resolver for the given strategy.
 */
export function createUriResolver(
  strategy: UriResolverStrategy,
  config: UriResolverConfig = {},
): UriResolver {
  switch (strategy) {
    case 'static':
      return createStaticResolver(config.staticMap ?? {})
    case 'convention':
      return createConventionResolver(config.urlTemplate ?? 'https://{org}.agents.forge.dev/{name}')
    case 'registry':
      return createRegistryResolver(config)
  }
}

// ---------------------------------------------------------------------------
// Resolver implementations
// ---------------------------------------------------------------------------

function createStaticResolver(map: Record<string, string>): UriResolver {
  return {
    async resolve(uri: string): Promise<string | null> {
      return map[uri] ?? null
    },
  }
}

function createConventionResolver(template: string): UriResolver {
  return {
    async resolve(uri: string): Promise<string | null> {
      if (!isForgeUri(uri)) return null
      const parsed = parseForgeUri(uri)
      return buildTemplateUrl(template, parsed)
    },
  }
}

function createRegistryResolver(config: UriResolverConfig): UriResolver {
  const registryUrl = config.registryUrl ?? 'https://registry.forge.dev'
  const timeoutMs = Math.max(0, config.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS)
  const maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_REGISTRY_RETRIES)
  const fetchImpl = config.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  const fallbackTemplate = config.urlTemplate

  return {
    async resolve(uri: string): Promise<string | null> {
      if (!isForgeUri(uri)) return null

      const parsed = parseForgeUri(uri)
      const fallbackUrl = fallbackTemplate
        ? buildTemplateUrl(fallbackTemplate, parsed)
        : null

      let lookupUrl: string
      try {
        lookupUrl = buildRegistryLookupUrl(registryUrl, parsed)
      } catch {
        return fallbackUrl
      }

      const attemptLimit = maxRetries + 1
      for (let attempt = 0; attempt < attemptLimit; attempt++) {
        const result = await performRegistryLookup(fetchImpl, lookupUrl, timeoutMs)
        if (result.kind === 'resolved') {
          return result.endpoint
        }

        if (result.kind !== 'retryable') {
          break
        }

        if (attempt === attemptLimit - 1) {
          break
        }
      }

      return fallbackUrl
    },
  }
}

function buildTemplateUrl(template: string, parsed: ParsedForgeUri): string {
  return template
    .replaceAll('{org}', parsed.organization)
    .replaceAll('{name}', parsed.agentName)
}

function buildRegistryLookupUrl(registryUrl: string, parsed: ParsedForgeUri): string {
  const base = registryUrl.endsWith('/') ? registryUrl : `${registryUrl}/`
  const lookup = new URL(`agents/${encodeURIComponent(parsed.organization)}/${encodeURIComponent(parsed.agentName)}`, base)
  if (parsed.version) {
    lookup.searchParams.set('version', parsed.version)
  }
  return lookup.toString()
}

async function performRegistryLookup(
  fetchImpl: RegistryFetch | undefined,
  lookupUrl: string,
  timeoutMs: number,
): Promise<RegistryLookupResult> {
  if (!fetchImpl) {
    return { kind: 'terminal' }
  }

  const controller = new AbortController()
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  try {
    const request = fetchImpl(lookupUrl, { signal: controller.signal })
    const timeout = new Promise<RegistryLookupResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        controller.abort()
        resolve({ kind: 'retryable', reason: 'timeout' })
      }, timeoutMs)
    })

    const settled = await Promise.race([
      request.then(async (response) => {
        const result = await readRegistryResponse(response)
        return result
      }).catch((error: unknown) => classifyRegistryError(error)),
      timeout,
    ])

    return settled
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
  }
}

async function readRegistryResponse(response: RegistryFetchResponse): Promise<RegistryLookupResult> {
  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      return { kind: 'not_found' }
    }

    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      return { kind: 'retryable', reason: 'network' }
    }

    if (response.status >= 400 && response.status < 500) {
      return { kind: 'terminal' }
    }

    return { kind: 'retryable', reason: 'network' }
  }

  try {
    const body = await response.text()
    const endpoint = extractRegistryEndpoint(body)
    if (!endpoint) {
      return { kind: 'terminal' }
    }
    return { kind: 'resolved', endpoint }
  } catch {
    return { kind: 'terminal' }
  }
}

function classifyRegistryError(error: unknown): RegistryLookupResult {
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'retryable', reason: 'timeout' }
  }

  return { kind: 'retryable', reason: 'network' }
}

function extractRegistryEndpoint(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed) return null

  const direct = normalizeRegistryEndpoint(trimmed)
  if (direct) return direct

  try {
    const parsed = JSON.parse(trimmed) as unknown
    return extractEndpointFromPayload(parsed)
  } catch {
    return null
  }
}

function extractEndpointFromPayload(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return normalizeRegistryEndpoint(payload)
  }

  if (!isRecord(payload)) return null

  const candidateFields = [
    'endpoint',
    'url',
    'uri',
    'agentUrl',
    'location',
    'href',
  ] as const

  for (const field of candidateFields) {
    const candidate = payload[field]
    const endpoint = extractEndpointFromPayload(candidate)
    if (endpoint) return endpoint
  }

  const nestedCandidates = ['data', 'result', 'value'] as const
  for (const field of nestedCandidates) {
    const candidate = payload[field]
    const endpoint = extractEndpointFromPayload(candidate)
    if (endpoint) return endpoint
  }

  return null
}

function normalizeRegistryEndpoint(value: string): string | null {
  const candidate = value.trim()
  if (!candidate) return null

  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
