import { lookup as defaultLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export interface OutboundUrlSecurityPolicy {
  /**
   * Explicit host allowlist for trusted internal deployments.
   *
   * Entries may be hostnames (`internal.example`), bracketless IPv6 literals,
   * or host:port pairs. Allowlisting bypasses public-destination checks and
   * should only be used for endpoints owned by the deployment.
   */
  allowedHosts?: ReadonlySet<string> | readonly string[] | undefined
  /**
   * Explicit resolved IP allowlist for trusted internal deployments.
   *
   * These entries bypass public-IP checks when a hostname resolves to a
   * non-public address. Use this only when DNS and network ownership are known.
   */
  allowedIpAddresses?: ReadonlySet<string> | readonly string[] | undefined
  /** Allow plain HTTP for trusted deployments. Defaults to false. */
  allowHttp?: boolean | undefined
  /** Optional custom blocked hosts in addition to built-in local names. */
  blockedHosts?: ReadonlySet<string> | readonly string[] | undefined
  /** Disable DNS resolution checks. Intended only for tests or constrained runtimes. */
  resolveDns?: boolean | undefined
  /** DNS lookup override for deterministic tests. */
  lookup?: ((hostname: string) => Promise<readonly OutboundUrlResolvedAddress[]>) | undefined
}

export interface OutboundUrlResolvedAddress {
  address: string
  family?: number | undefined
}

export type OutboundUrlPolicyResult =
  | { ok: true; url: URL; resolvedAddresses: OutboundUrlResolvedAddress[] }
  | { ok: false; reason: string }

export interface SecureFetchOptions {
  policy?: OutboundUrlSecurityPolicy | undefined
  maxRedirects?: number | undefined
  followRedirects?: boolean | undefined
  fetchImpl?: typeof fetch | undefined
}

const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
])
const RESERVED_EXAMPLE_HOSTS = new Set([
  'example.com',
  'example.net',
  'example.org',
])

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

function toSet(values?: ReadonlySet<string> | readonly string[]): Set<string> {
  if (!values) return new Set()
  return new Set(Array.from(values).map(normalizeHost).filter(Boolean))
}

function isHostAllowlisted(parsedUrl: URL, policy?: OutboundUrlSecurityPolicy): boolean {
  const allowedHosts = toSet(policy?.allowedHosts)
  if (allowedHosts.size === 0) return false

  const hostname = normalizeHostname(parsedUrl.hostname)
  const host = normalizeHost(parsedUrl.host)
  return allowedHosts.has(hostname) || allowedHosts.has(host)
}

function isIpAllowlisted(address: string, policy?: OutboundUrlSecurityPolicy): boolean {
  const allowedIps = toSet(policy?.allowedIpAddresses)
  return allowedIps.has(normalizeHostname(address))
}

function parseIpv4(address: string): [number, number, number, number] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined

  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const value = Number(part)
    if (value < 0 || value > 255) return undefined
    bytes.push(value)
  }
  return [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!]
}

function isPublicIpv4(address: string): boolean {
  const bytes = parseIpv4(address)
  if (!bytes) return false

  const [a, b, c] = bytes
  if (a === 0) return false
  if (a === 10) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && c === 0) return false
  if (a === 192 && b === 0 && c === 2) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false

  return true
}

function isPublicIpv6(address: string): boolean {
  const normalized = normalizeHostname(address)
  if (!normalized) return false
  if (normalized === '::' || normalized === '::1') return false
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return false
  if (normalized.startsWith('ff')) return false

  if (normalized.startsWith('::ffff:')) {
    return isPublicIpv4(normalized.slice('::ffff:'.length))
  }

  return true
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address)
  const version = isIP(normalized)
  if (version === 4) return isPublicIpv4(normalized)
  if (version === 6) return isPublicIpv6(normalized)
  return false
}

export function validateOutboundUrlSyntax(
  url: string | URL,
  policy?: OutboundUrlSecurityPolicy,
): OutboundUrlPolicyResult {
  let parsedUrl: URL
  try {
    parsedUrl = typeof url === 'string' ? new URL(url) : new URL(url.href)
  } catch {
    return { ok: false, reason: `URL "${String(url)}" is invalid.` }
  }

  if (!parsedUrl.hostname) {
    return { ok: false, reason: 'URL host is required.' }
  }

  const isAllowlistedHost = isHostAllowlisted(parsedUrl, policy)
  const allowHttp = policy?.allowHttp === true || isAllowlistedHost
  if (parsedUrl.protocol !== 'https:' && !(allowHttp && parsedUrl.protocol === 'http:')) {
    return { ok: false, reason: 'URL protocol must be https unless trusted HTTP is explicitly allowed.' }
  }

  const hostname = normalizeHostname(parsedUrl.hostname)
  const blockedHosts = new Set([...DEFAULT_BLOCKED_HOSTS, ...toSet(policy?.blockedHosts)])
  if (!isAllowlistedHost && (blockedHosts.has(hostname) || hostname.endsWith('.localhost'))) {
    return { ok: false, reason: `URL host "${parsedUrl.hostname}" is blocked.` }
  }

  const ipVersion = isIP(hostname)
  if (ipVersion !== 0 && !isAllowlistedHost && !isIpAllowlisted(hostname, policy) && !isPublicIpAddress(hostname)) {
    return { ok: false, reason: `URL host "${parsedUrl.hostname}" is not a public IP address.` }
  }

  return { ok: true, url: parsedUrl, resolvedAddresses: ipVersion === 0 ? [] : [{ address: hostname, family: ipVersion }] }
}

export async function validateOutboundUrl(
  url: string | URL,
  policy?: OutboundUrlSecurityPolicy,
): Promise<OutboundUrlPolicyResult> {
  const syntax = validateOutboundUrlSyntax(url, policy)
  if (!syntax.ok) return syntax

  if (isHostAllowlisted(syntax.url, policy) || policy?.resolveDns === false) {
    return syntax
  }

  const hostname = normalizeHostname(syntax.url.hostname)
  if (isIP(hostname) !== 0) return syntax
  if (RESERVED_EXAMPLE_HOSTS.has(hostname) || hostname.endsWith('.example.com') || hostname.endsWith('.example.net') || hostname.endsWith('.example.org')) {
    return syntax
  }

  const lookup = policy?.lookup ?? (async (host: string) => defaultLookup(host, { all: true, verbatim: true }))
  let resolved: readonly OutboundUrlResolvedAddress[]
  try {
    resolved = await lookup(hostname)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `URL host "${syntax.url.hostname}" could not be resolved: ${message}` }
  }

  if (resolved.length === 0) {
    return { ok: false, reason: `URL host "${syntax.url.hostname}" did not resolve to any addresses.` }
  }

  for (const entry of resolved) {
    const address = normalizeHostname(entry.address)
    if (!isIpAllowlisted(address, policy) && !isPublicIpAddress(address)) {
      return {
        ok: false,
        reason: `URL host "${syntax.url.hostname}" resolved to non-public IP address "${entry.address}".`,
      }
    }
  }

  return { ok: true, url: syntax.url, resolvedAddresses: [...resolved] }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

export async function fetchWithOutboundUrlPolicy(
  url: string | URL,
  init: RequestInit = {},
  options: SecureFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const fetchImpl = options.fetchImpl ?? fetch
  let currentUrl = typeof url === 'string' ? url : url.href
  let currentInit = init

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const validation = await validateOutboundUrl(currentUrl, options.policy)
    if (!validation.ok) {
      throw new Error(`Outbound URL rejected: ${validation.reason}`)
    }

    const response = await fetchImpl(validation.url.href, {
      ...currentInit,
      redirect: 'manual',
    })

    if (!isRedirectStatus(response.status)) return response

    const location = response.headers.get('location')
    if (!location) return response
    if (options.followRedirects === false) return response
    if (redirectCount === maxRedirects) {
      throw new Error(`Outbound URL rejected: too many redirects after ${maxRedirects} hops.`)
    }

    currentUrl = new URL(location, validation.url).href

    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentInit.method?.toUpperCase() === 'POST')) {
      const { body: _body, ...rest } = currentInit
      currentInit = {
        ...rest,
        method: 'GET',
      }
    }
  }

  throw new Error(`Outbound URL rejected: too many redirects after ${maxRedirects} hops.`)
}
