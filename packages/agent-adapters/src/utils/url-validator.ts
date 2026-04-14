/**
 * Webhook URL SSRF protection utilities.
 *
 * Validates webhook URLs to prevent Server-Side Request Forgery (SSRF) attacks
 * by blocking private IP ranges, cloud metadata endpoints, and other dangerous
 * destinations.
 */

import { ForgeError } from '@dzupagent/core'

/** Options for webhook URL validation. */
export interface UrlValidationOptions {
  /** Allow plain HTTP URLs (default: false, only HTTPS allowed). */
  allowHttp?: boolean | undefined
  /** Additional hostnames to block. */
  blockedHosts?: string[] | undefined
  /** Hostnames to always allow, bypassing all block checks. */
  allowedHosts?: string[] | undefined
}

// ---------------------------------------------------------------------------
// Private IP range checkers
// ---------------------------------------------------------------------------

/** IPv4 private/reserved CIDR blocks that must be blocked. */
const BLOCKED_IPV4_PATTERNS: Array<{ prefix: number[]; bits: number }> = [
  // 127.0.0.0/8 -- loopback
  { prefix: [127], bits: 8 },
  // 10.0.0.0/8 -- private class A
  { prefix: [10], bits: 8 },
  // 172.16.0.0/12 -- private class B
  { prefix: [172, 16], bits: 12 },
  // 192.168.0.0/16 -- private class C
  { prefix: [192, 168], bits: 16 },
  // 169.254.0.0/16 -- link-local (includes cloud metadata 169.254.169.254)
  { prefix: [169, 254], bits: 16 },
  // 0.0.0.0/8 -- "this" network
  { prefix: [0], bits: 8 },
]

function parseIPv4(host: string): number[] | undefined {
  const parts = host.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255 || part !== String(n)) {
      return undefined
    }
    octets.push(n)
  }
  return octets
}

function ipToNumber(octets: number[]): number {
   
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0
}

function isBlockedIPv4(octets: number[]): boolean {
  const ip = ipToNumber(octets)
  for (const { prefix, bits } of BLOCKED_IPV4_PATTERNS) {
    const padded = [...prefix, 0, 0, 0, 0].slice(0, 4) as [number, number, number, number]
    const net = ipToNumber(padded)
     
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
     
    if ((ip & mask) === (net & mask)) return true
  }
  return false
}

/** Known dangerous IPv6 addresses and prefixes. */
function isBlockedIPv6(host: string): boolean {
  const normalized = host.replace(/^\[/, '').replace(/]$/, '').toLowerCase()
  // ::1 loopback
  if (normalized === '::1') return true
  // fd00::/8 -- unique local addresses
  if (normalized.startsWith('fd')) return true
  // fe80::/10 -- link-local
  if (normalized.startsWith('fe80')) return true
  // :: (unspecified)
  if (normalized === '::') return true
  return false
}

/** Well-known hostnames that resolve to loopback. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', 'localhost.localdomain'])

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a webhook URL, throwing a {@link ForgeError} if it targets a
 * blocked destination (private networks, cloud metadata, etc.).
 *
 * @param url     - The URL string to validate.
 * @param options - Optional validation settings.
 * @throws ForgeError with code `WEBHOOK_URL_BLOCKED` on violation.
 */
export function validateWebhookUrl(url: string, options?: UrlValidationOptions): void {
  // 1. Parse
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ForgeError({
      code: 'VALIDATION_FAILED',
      message: `Malformed webhook URL: ${url}`,
      recoverable: false,
    })
  }

  // 2. Protocol check
  const allowHttp = options?.allowHttp ?? false
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new ForgeError({
      code: 'VALIDATION_FAILED',
      message: `Webhook URL must use HTTPS${allowHttp ? ' or HTTP' : ''}: ${url}`,
      recoverable: false,
    })
  }

  const hostname = parsed.hostname.toLowerCase()

  // 3. Allowed-list bypass (checked before block lists)
  if (options?.allowedHosts?.includes(hostname)) {
    return
  }

  // 4. Custom blocked hosts
  if (options?.blockedHosts?.includes(hostname)) {
    throw new ForgeError({
      code: 'VALIDATION_FAILED',
      message: `Webhook URL hostname is explicitly blocked: ${hostname}`,
      recoverable: false,
    })
  }

  // 5. Loopback hostnames
  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new ForgeError({
      code: 'VALIDATION_FAILED',
      message: `Webhook URL points to loopback address: ${hostname}`,
      recoverable: false,
    })
  }

  // 6. IPv4 checks
  const ipv4 = parseIPv4(hostname)
  if (ipv4 && isBlockedIPv4(ipv4)) {
    throw new ForgeError({
      code: 'VALIDATION_FAILED',
      message: `Webhook URL points to a private/reserved IP range: ${hostname}`,
      recoverable: false,
    })
  }

  // 7. IPv6 checks (hostnames in URLs are wrapped in brackets, URL parser strips them)
  if (isBlockedIPv6(hostname)) {
    throw new ForgeError({
      code: 'VALIDATION_FAILED',
      message: `Webhook URL points to a blocked IPv6 address: ${hostname}`,
      recoverable: false,
    })
  }
}
