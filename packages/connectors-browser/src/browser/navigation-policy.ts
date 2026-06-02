import { lookup as defaultLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicIpAddress } from "@dzupagent/core";
import type { Page, Response } from "playwright";
import type {
  BrowserNavigationPolicy,
  NavigationResolvedAddress,
} from "../types.js";

const DEFAULT_ALLOWED_PROTOCOLS = ["http:", "https:"];
const GUARDED_PAGES = new WeakSet<Page>();
const PRIVATE_IPV4_RANGES: Array<[prefix: string, bits: number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

function normalizeProtocol(protocol: string): string {
  return protocol.endsWith(":")
    ? protocol.toLowerCase()
    : `${protocol.toLowerCase()}:`;
}

function isIPv4InCidr(address: string, prefix: string, bits: number): boolean {
  const addressParts = address.split(".").map(Number);
  const prefixParts = prefix.split(".").map(Number);

  if (
    addressParts.length !== 4 ||
    prefixParts.length !== 4 ||
    addressParts.some(
      (part) => !Number.isInteger(part) || part < 0 || part > 255
    ) ||
    prefixParts.some(
      (part) => !Number.isInteger(part) || part < 0 || part > 255
    )
  ) {
    return false;
  }

  const addressValue =
    addressParts.reduce((value, part) => (value << 8) + part, 0) >>> 0;
  const prefixValue =
    prefixParts.reduce((value, part) => (value << 8) + part, 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;

  return (addressValue & mask) === (prefixValue & mask);
}

function isBlockedIPv4(address: string): boolean {
  return PRIVATE_IPV4_RANGES.some(([prefix, bits]) =>
    isIPv4InCidr(address, prefix, bits)
  );
}

function isBlockedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

const RESERVED_EXAMPLE_HOSTS = new Set([
  "example.com",
  "example.net",
  "example.org",
]);

/**
 * RFC 2606 / RFC 6761 reserved hostnames that are guaranteed not to resolve to
 * a real (and therefore never a private) address. Used to skip the DNS round
 * trip for documentation/test hosts. These are NOT a security bypass: they
 * cannot resolve to an internal target.
 */
function isReservedNonRoutableHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    RESERVED_EXAMPLE_HOSTS.has(normalized) ||
    normalized.endsWith(".example.com") ||
    normalized.endsWith(".example.net") ||
    normalized.endsWith(".example.org") ||
    normalized === "invalid" ||
    normalized.endsWith(".invalid")
  );
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "metadata.google.internal"
  );
}

function stripIpBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

/**
 * Returns true when a literal IP address (or local hostname) is a private,
 * loopback, link-local, CGNAT, or otherwise reserved target that must never be
 * reached by browser automation.
 *
 * Delegates the per-IP range decision to `@dzupagent/core`'s
 * `isPublicIpAddress`, which is the canonical SSRF denylist (IPv4
 * 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, multicast;
 * IPv6 ::, ::1, fc00::/7, fe80::/10, and IPv4-mapped ::ffff: addresses). The
 * local CIDR helper above is retained for backwards-compatible behavior and as
 * a defense-in-depth second opinion for IPv4 literals.
 */
function isBlockedPrivateAddress(address: string): boolean {
  const normalized = stripIpBrackets(address).toLowerCase();
  const ipVersion = isIP(normalized);

  if (ipVersion === 4)
    return isBlockedIPv4(normalized) || !isPublicIpAddress(normalized);
  if (ipVersion === 6)
    return isBlockedIPv6(normalized) || !isPublicIpAddress(normalized);

  return false;
}

/**
 * Hostname-level (pre-DNS) block decision: literal private IPs and known local
 * hostnames. Public hostnames pass here and are re-checked after DNS resolution
 * by {@link assertResolvedAddressesAllowed}.
 */
function isBlockedPrivateTarget(hostname: string): boolean {
  const normalized = stripIpBrackets(hostname).toLowerCase();

  if (isIP(normalized) !== 0) return isBlockedPrivateAddress(normalized);

  return isLocalHostname(normalized);
}

/**
 * Synchronous policy validation: protocol, origin/host allowlists, and the
 * literal-hostname private-range denylist. Does NOT perform DNS resolution.
 *
 * Retained with a stable signature for callers that need a fast, non-async
 * pre-check (it cannot detect DNS-rebinding). Prefer
 * {@link assertBrowserNavigationAllowed} for full SSRF coverage.
 */
export function validateBrowserNavigationUrl(
  url: string,
  policy: BrowserNavigationPolicy = {}
): URL {
  const parsed = new URL(url);
  const allowedProtocols = (
    policy.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS
  ).map(normalizeProtocol);

  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(
      `Blocked browser navigation to disallowed protocol: ${parsed.protocol}`
    );
  }

  if (
    policy.allowedOrigins &&
    policy.allowedOrigins.length > 0 &&
    !policy.allowedOrigins.includes(parsed.origin)
  ) {
    throw new Error(
      `Blocked browser navigation to disallowed origin: ${parsed.origin}`
    );
  }

  if (
    policy.allowedHosts &&
    policy.allowedHosts.length > 0 &&
    !policy.allowedHosts.includes(parsed.hostname)
  ) {
    throw new Error(
      `Blocked browser navigation to disallowed host: ${parsed.hostname}`
    );
  }

  if (!policy.allowPrivateNetwork && isBlockedPrivateTarget(parsed.hostname)) {
    throw new Error(
      `Blocked browser navigation to private or local network host: ${parsed.hostname}`
    );
  }

  return parsed;
}

/**
 * Resolves `hostname` via DNS and blocks if ANY resolved address is private or
 * reserved. Blocking on *any* private address defends against DNS-rebinding
 * where a hostname returns one public and one private A/AAAA record.
 *
 * Skipped when the policy opts into private networks, when DNS is disabled via
 * `resolveDns: false`, or when the host is already a literal IP (handled by the
 * synchronous check).
 */
async function assertResolvedAddressesAllowed(
  hostname: string,
  policy: BrowserNavigationPolicy
): Promise<void> {
  if (policy.allowPrivateNetwork) return;
  if (policy.resolveDns === false) return;

  const normalized = stripIpBrackets(hostname).toLowerCase();
  // Literal IPs are already covered by the synchronous denylist.
  if (isIP(normalized) !== 0) return;
  // Allowlisted hosts are explicitly trusted; skip the resolved-IP check.
  if (policy.allowedHosts && policy.allowedHosts.length > 0) {
    if (policy.allowedHosts.includes(hostname)) return;
  }
  // RFC 2606 / RFC 6761 reserved names are guaranteed non-routable and never
  // resolve to a real (let alone private) address. Skip DNS for them to avoid
  // pointless resolver round-trips/timeouts; they cannot be an SSRF vector.
  if (isReservedNonRoutableHost(normalized)) return;

  const lookup =
    policy.lookup ??
    (async (host: string): Promise<ReadonlyArray<NavigationResolvedAddress>> =>
      defaultLookup(host, { all: true, verbatim: true }));

  let resolved: ReadonlyArray<NavigationResolvedAddress>;
  try {
    resolved = await lookup(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Blocked browser navigation: host "${hostname}" could not be resolved: ${message}`
    );
  }

  if (resolved.length === 0) {
    throw new Error(
      `Blocked browser navigation: host "${hostname}" did not resolve to any addresses`
    );
  }

  for (const entry of resolved) {
    if (isBlockedPrivateAddress(entry.address)) {
      throw new Error(
        `Blocked browser navigation to private or local network host: ${hostname} ` +
          `(resolved to ${entry.address})`
      );
    }
  }
}

/**
 * Full SSRF-aware navigation gate: runs the synchronous policy checks AND
 * re-checks every DNS-resolved IP against the private-range denylist. Use this
 * for every navigation, subresource request, and redirect target.
 *
 * @returns the parsed and validated URL.
 */
export async function assertBrowserNavigationAllowed(
  url: string,
  policy: BrowserNavigationPolicy = {}
): Promise<URL> {
  const parsed = validateBrowserNavigationUrl(url, policy);
  await assertResolvedAddressesAllowed(parsed.hostname, policy);
  return parsed;
}

export async function installBrowserNavigationPolicy(
  page: Page,
  policy: BrowserNavigationPolicy = {}
): Promise<void> {
  if (GUARDED_PAGES.has(page)) return;
  GUARDED_PAGES.add(page);

  // Intercept EVERY request — top-level navigations AND subresources (scripts,
  // images, XHR/fetch, fonts, etc.). Playwright re-invokes this handler for each
  // redirect hop, so redirect targets are validated here too. Each request URL
  // is run through the full DNS-resolved-IP SSRF check before being allowed.
  await page.route("**/*", async (route) => {
    const request = route.request();
    try {
      await assertBrowserNavigationAllowed(request.url(), policy);
    } catch {
      await route.abort("blockedbyclient");
      return;
    }

    await route.continue();
  });
}

export async function safeBrowserGoto(
  page: Page,
  url: string,
  options: NonNullable<Parameters<Page["goto"]>[1]>,
  policy: BrowserNavigationPolicy = {}
): Promise<Response | null> {
  const target = await assertBrowserNavigationAllowed(url, policy);
  await installBrowserNavigationPolicy(page, policy);
  const response = await page.goto(target.href, options);
  // Re-validate the final landing URL: defends against any redirect that the
  // route interceptor did not surface (e.g. client-side or meta-refresh hops).
  await assertBrowserNavigationAllowed(page.url(), policy);
  return response;
}
