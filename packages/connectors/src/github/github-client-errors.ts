/**
 * GitHub REST API client — error type, secret redaction, and outbound policy.
 *
 * These helpers are re-exported (where public) from `./github-client.js` so the
 * public surface stays stable.
 */
import type { OutboundUrlSecurityPolicy } from "@dzupagent/core/security";

export class GitHubApiError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, body: string) {
    const redactedBody = redactSensitiveText(body);
    super(`GitHub API error ${status}: ${redactedBody.slice(0, 200)}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.body = redactedBody;
  }
}

export function defaultGitHubOutboundPolicy(
  baseUrl: string
): OutboundUrlSecurityPolicy | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname === "api.github.com") {
      return { allowedHosts: ["api.github.com"] };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
      "[REDACTED_GITHUB_TOKEN]"
    )
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
}
