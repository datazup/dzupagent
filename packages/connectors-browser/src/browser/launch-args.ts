import { isIP } from "node:net";
import type { BrowserHostResolverRule } from "../types.js";

/**
 * Chromium launch-argument rendering.
 *
 * This package exposes NO general `args` passthrough to `chromium.launch()`.
 * Arbitrary caller-supplied Chromium flags are an attack surface in their own
 * right (`--disable-web-security` kills the same-origin policy,
 * `--remote-debugging-port` hands out a full CDP channel, `--no-sandbox`
 * removes process isolation, `--user-data-dir` redirects credential storage).
 * Instead, each capability is a typed option that this module renders into the
 * single correct flag, so the flag syntax lives in one testable place and the
 * set of reachable flags is closed by construction.
 */

/**
 * Allowlist, not a denylist: a host must be dot-separated LDH labels
 * (letters/digits/hyphen, RFC 1123) and nothing else. This is what makes the
 * rendering injection-proof — `,` (rule separator), whitespace (field
 * separator), `*` (wildcard patterns) and `:` / `[` / `]` (port and IPv6
 * syntax) simply cannot appear, so a caller cannot smuggle a second rule such
 * as `MAP * evil.example.com` through the `host` field.
 */
const HOST_LABEL_CHARS = /^[A-Za-z0-9-]+$/;

/**
 * Single-quantifier, backtracking-free label check (an anchored nested
 * quantifier would be flagged by security/detect-unsafe-regex): the character
 * class is tested on its own and the RFC 1123 "no leading/trailing hyphen"
 * rule is applied with plain string comparisons.
 */
function isValidHostLabel(label: string): boolean {
  if (label.length === 0 || label.length > 63) return false;
  if (label.startsWith("-") || label.endsWith("-")) return false;
  return HOST_LABEL_CHARS.test(label);
}

function assertValidHost(host: string): void {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) {
    throw new Error(
      `Invalid host resolver rule: host must be a non-empty hostname (<=253 chars), got ${JSON.stringify(host)}`
    );
  }
  const labels = host.split(".");
  if (!labels.every(isValidHostLabel)) {
    throw new Error(
      `Invalid host resolver rule: host ${JSON.stringify(host)} is not a plain hostname (wildcards, ports and separators are rejected)`
    );
  }
}

function assertValidAddress(address: string): number {
  const family = typeof address === "string" ? isIP(address) : 0;
  if (family === 0) {
    throw new Error(
      `Invalid host resolver rule: address must be an IPv4 or IPv6 literal, got ${JSON.stringify(address)}`
    );
  }
  return family;
}

function assertValidPort(port: number | undefined): void {
  if (port === undefined) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid host resolver rule: port must be an integer in 1-65535, got ${JSON.stringify(port)}`
    );
  }
}

/**
 * Render host pins into Chromium's `--host-resolver-rules` value.
 *
 * Returns `null` when there is nothing to pin, so callers omit the flag
 * entirely rather than passing an empty one.
 *
 * @throws if any rule is malformed — validation is fail-closed, a bad rule is
 *   never silently dropped (a dropped pin is a silently disabled defense).
 */
export function renderHostResolverRules(
  rules: readonly BrowserHostResolverRule[] | undefined
): string | null {
  if (!rules || rules.length === 0) return null;

  return rules
    .map((rule) => {
      if (rule === null || typeof rule !== "object") {
        throw new Error(
          `Invalid host resolver rule: expected an object, got ${JSON.stringify(rule)}`
        );
      }
      assertValidHost(rule.host);
      const family = assertValidAddress(rule.address);
      assertValidPort(rule.port);

      // IPv6 replacements are bracketed so an optional :port is unambiguous.
      const target = family === 6 ? `[${rule.address}]` : rule.address;
      const suffix = rule.port === undefined ? "" : `:${rule.port}`;
      return `MAP ${rule.host} ${target}${suffix}`;
    })
    .join(",");
}

/**
 * Build the complete, closed set of Chromium launch arguments for the given
 * options. Every element is produced here — nothing is forwarded from callers.
 */
export function buildChromiumLaunchArgs(opts?: {
  hostResolverRules?: readonly BrowserHostResolverRule[] | undefined;
}): string[] {
  const args: string[] = [];
  const hostResolverRules = renderHostResolverRules(opts?.hostResolverRules);
  if (hostResolverRules !== null) {
    args.push(`--host-resolver-rules=${hostResolverRules}`);
  }
  return args;
}
