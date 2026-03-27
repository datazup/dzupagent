/**
 * Forge URI scheme — identity URIs for DzipAgent agents.
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
  /** For 'convention' strategy: base URL template with {org} and {name} placeholders. */
  urlTemplate?: string
  /** For 'registry' strategy: registry endpoint URL. */
  registryUrl?: string
}

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
      return createRegistryResolver(config.registryUrl ?? 'https://registry.forge.dev')
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
      return template
        .replace('{org}', parsed.organization)
        .replace('{name}', parsed.agentName)
    },
  }
}

function createRegistryResolver(registryUrl: string): UriResolver {
  return {
    async resolve(uri: string): Promise<string | null> {
      if (!isForgeUri(uri)) return null
      // Registry resolution is a placeholder — real implementation would do an HTTP lookup.
      // For now, return the registry lookup URL so callers know where to query.
      const parsed = parseForgeUri(uri)
      const versionSuffix = parsed.version ? `?version=${parsed.version}` : ''
      return `${registryUrl}/agents/${parsed.organization}/${parsed.agentName}${versionSuffix}`
    },
  }
}
