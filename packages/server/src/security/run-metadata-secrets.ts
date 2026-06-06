import type { Run } from "@dzupagent/core/persistence";

const REDACTED = "[REDACTED]";

const TOP_LEVEL_SECRET_METADATA_KEYS = new Set([
  "githubToken",
  "slackToken",
  "httpHeaders",
  "httpAuthorization",
  "httpBearerToken",
  "mcpEnv",
  "mcpHeaders",
]);

/**
 * Key-name fragments that mark a value as a credential at ANY nesting depth.
 * Matched case-insensitively as a substring of the key (so `password`,
 * `dbPassword`, `apiToken`, `client_secret`, `apiKey` all match).
 */
const SECRET_KEY_PATTERNS = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "credential",
  "authorization",
  "bearer",
];

const NON_SECRET_KEY_ALLOWLIST = new Set([
  "maxTokens",
]);

/** `key=value` credential patterns embedded in free-form strings (e.g. env vars). */
const SECRET_VALUE_REGEX =
  /\b(password|secret|token|apikey|api_key|credential)\s*=/i;

function isSecretKey(key: string): boolean {
  // Explicit named secret keys are redacted at any depth, as are keys whose
  // name contains a known credential fragment.
  if (NON_SECRET_KEY_ALLOWLIST.has(key)) return false;
  if (TOP_LEVEL_SECRET_METADATA_KEYS.has(key)) return true;
  const lower = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => lower.includes(p));
}

function looksLikeCredentialString(value: string): boolean {
  return SECRET_VALUE_REGEX.test(value);
}

/**
 * Recursively scrub a metadata value (SEC-L-01):
 * - any value whose KEY matches a secret pattern → `[REDACTED]` (at any depth);
 * - any STRING that looks like a `key=value` credential → `[REDACTED]`;
 * - objects/arrays are traversed; non-secret primitives pass through unchanged.
 */
function scrubValue(value: unknown): unknown {
  if (typeof value === "string") {
    return looksLikeCredentialString(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : scrubValue(v);
    }
    return out;
  }
  return value;
}

function sanitizeMcpServerEntry(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const entry = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = { ...entry };
  delete sanitized["env"];
  delete sanitized["headers"];
  // Recurse into whatever remains so nested secrets are still scrubbed.
  return scrubValue(sanitized);
}

export function sanitizeRunMetadataForPersistence(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  // 1) Drop the explicit top-level secret keys entirely (back-compat).
  const withoutTopLevel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (TOP_LEVEL_SECRET_METADATA_KEYS.has(key)) continue;
    withoutTopLevel[key] = value;
  }

  // 2) Deep recursive scrub of every remaining key/value.
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(withoutTopLevel)) {
    if (key === "mcpServers" && Array.isArray(value)) {
      // mcpServers entries get env/headers stripped, then a recursive scrub.
      result[key] = value.map(sanitizeMcpServerEntry);
      continue;
    }
    result[key] = isSecretKey(key) ? REDACTED : scrubValue(value);
  }

  return result;
}

export function sanitizeRunForResponse<T extends Run>(run: T): T {
  const metadata = sanitizeRunMetadataForPersistence(run.metadata ?? undefined);
  return {
    ...run,
    ...(metadata !== undefined ? { metadata } : { metadata: undefined }),
  };
}
