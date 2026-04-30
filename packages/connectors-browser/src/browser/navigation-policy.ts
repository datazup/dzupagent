import { isIP } from 'node:net'
import type { Page, Response } from 'playwright'
import type { BrowserNavigationPolicy } from '../types.js'

const DEFAULT_ALLOWED_PROTOCOLS = ['http:', 'https:']
const GUARDED_PAGES = new WeakSet<Page>()
const PRIVATE_IPV4_RANGES: Array<[prefix: string, bits: number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
]

function normalizeProtocol(protocol: string): string {
  return protocol.endsWith(':') ? protocol.toLowerCase() : `${protocol.toLowerCase()}:`
}

function isIPv4InCidr(address: string, prefix: string, bits: number): boolean {
  const addressParts = address.split('.').map(Number)
  const prefixParts = prefix.split('.').map(Number)

  if (
    addressParts.length !== 4 ||
    prefixParts.length !== 4 ||
    addressParts.some(part => !Number.isInteger(part) || part < 0 || part > 255) ||
    prefixParts.some(part => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false
  }

  const addressValue = addressParts.reduce((value, part) => (value << 8) + part, 0) >>> 0
  const prefixValue = prefixParts.reduce((value, part) => (value << 8) + part, 0) >>> 0
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0

  return (addressValue & mask) === (prefixValue & mask)
}

function isBlockedIPv4(address: string): boolean {
  return PRIVATE_IPV4_RANGES.some(([prefix, bits]) => isIPv4InCidr(address, prefix, bits))
}

function isBlockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase()
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  )
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'metadata.google.internal'
  )
}

function isBlockedPrivateTarget(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const ipVersion = isIP(normalized)

  if (ipVersion === 4) return isBlockedIPv4(normalized)
  if (ipVersion === 6) return isBlockedIPv6(normalized)

  return isLocalHostname(normalized)
}

export function validateBrowserNavigationUrl(
  url: string,
  policy: BrowserNavigationPolicy = {},
): URL {
  const parsed = new URL(url)
  const allowedProtocols = (policy.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS).map(
    normalizeProtocol,
  )

  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(`Blocked browser navigation to disallowed protocol: ${parsed.protocol}`)
  }

  if (
    policy.allowedOrigins &&
    policy.allowedOrigins.length > 0 &&
    !policy.allowedOrigins.includes(parsed.origin)
  ) {
    throw new Error(`Blocked browser navigation to disallowed origin: ${parsed.origin}`)
  }

  if (
    policy.allowedHosts &&
    policy.allowedHosts.length > 0 &&
    !policy.allowedHosts.includes(parsed.hostname)
  ) {
    throw new Error(`Blocked browser navigation to disallowed host: ${parsed.hostname}`)
  }

  if (!policy.allowPrivateNetwork && isBlockedPrivateTarget(parsed.hostname)) {
    throw new Error(
      `Blocked browser navigation to private or local network host: ${parsed.hostname}`,
    )
  }

  return parsed
}

export async function installBrowserNavigationPolicy(
  page: Page,
  policy: BrowserNavigationPolicy = {},
): Promise<void> {
  if (GUARDED_PAGES.has(page)) return
  GUARDED_PAGES.add(page)

  await page.route('**/*', async route => {
    const request = route.request()
    if (request.isNavigationRequest() || request.resourceType() === 'document') {
      try {
        validateBrowserNavigationUrl(request.url(), policy)
      } catch {
        await route.abort('blockedbyclient')
        return
      }
    }

    await route.continue()
  })
}

export async function safeBrowserGoto(
  page: Page,
  url: string,
  options: NonNullable<Parameters<Page['goto']>[1]>,
  policy: BrowserNavigationPolicy = {},
): Promise<Response | null> {
  const target = validateBrowserNavigationUrl(url, policy)
  await installBrowserNavigationPolicy(page, policy)
  const response = await page.goto(target.href, options)
  validateBrowserNavigationUrl(page.url(), policy)
  return response
}
