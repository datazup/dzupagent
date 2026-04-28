import { isIP } from 'node:net'

export interface McpHttpUrlPolicy {
  allowedHosts?: ReadonlySet<string> | readonly string[] | undefined
}

export type McpHttpUrlPolicyResult =
  | { ok: true }
  | { ok: false; reason: string }

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

function normalizeAllowedHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function getAllowedHosts(policy?: McpHttpUrlPolicy): Set<string> | undefined {
  if (!policy?.allowedHosts) return undefined
  const entries = Array.from(policy.allowedHosts)
    .map(normalizeAllowedHost)
    .filter(Boolean)
  return entries.length ? new Set(entries) : undefined
}

function isHostAllowlisted(parsedUrl: URL, policy?: McpHttpUrlPolicy): boolean {
  const allowedHosts = getAllowedHosts(policy)
  if (!allowedHosts) return false

  const hostname = normalizeHostname(parsedUrl.hostname)
  const host = normalizeAllowedHost(parsedUrl.host)
  return allowedHosts.has(hostname) || allowedHosts.has(host)
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
  const parts = hostname.split('.')
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

function isPrivateIpv4(hostname: string): boolean {
  const bytes = parseIpv4(hostname)
  if (!bytes) return false

  const [a, b] = bytes
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
  )
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  if (normalized === '::1') return true
  if (normalized.startsWith('fe80:')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true

  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpv4(normalized.slice('::ffff:'.length))
  }

  return false
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  if (!normalized) return true
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true

  const ipVersion = isIP(normalized)
  if (ipVersion === 4) return isPrivateIpv4(normalized)
  if (ipVersion === 6) return isPrivateIpv6(normalized)

  return false
}

export function validateMcpHttpEndpoint(
  endpoint: string,
  transport: 'http' | 'sse',
  policy?: McpHttpUrlPolicy,
): McpHttpUrlPolicyResult {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(endpoint)
  } catch {
    return { ok: false, reason: `URL "${endpoint}" is invalid.` }
  }

  if (!ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
    return { ok: false, reason: `URL protocol must be http/https for ${transport}.` }
  }

  if (!parsedUrl.hostname) {
    return { ok: false, reason: 'URL host is required.' }
  }

  if (isHostAllowlisted(parsedUrl, policy)) {
    return { ok: true }
  }

  if (isPrivateOrLocalHost(parsedUrl.hostname)) {
    return {
      ok: false,
      reason: `URL host "${parsedUrl.hostname}" is private, loopback, or link-local and must be allowlisted.`,
    }
  }

  return { ok: true }
}
