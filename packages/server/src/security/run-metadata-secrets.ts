import type { Run } from '@dzupagent/core/persistence'

/**
 * Top-level metadata keys that are dropped entirely because they typically
 * hold structured credential objects (not just strings).
 */
const TOP_LEVEL_SECRET_METADATA_KEYS = new Set([
  'githubToken',
  'slackToken',
  'httpHeaders',
  'httpAuthorization',
  'httpBearerToken',
  'mcpEnv',
  'mcpHeaders',
])

/**
 * Credential-pattern regex applied to both object keys and standalone string
 * values.  Matches common secret names: passwords, tokens, secrets, API keys,
 * bearer values, and private-key identifiers.
 *
 * When a key matches, its value is redacted unconditionally (so opaque values
 * like JWTs or random hex strings are still scrubbed).
 * When a standalone string value matches (e.g., an array element containing
 * "password=abc"), it is also redacted.
 */
const CREDENTIAL_PATTERN =
  /(?:password|passwd|secret|token|apikey|api_key|bearer|authorization|private[_-]?key)/i

/** Sentinel value substituted for scrubbed content. */
const REDACTED = '[REDACTED]'

/**
 * Recursively walk `value` and redact credential data.
 *
 * Rules applied in order:
 * 1. Object entry: if the key matches CREDENTIAL_PATTERN, replace the entire
 *    value with REDACTED (regardless of type); otherwise recurse into the value.
 * 2. Array entry: recurse into each element.
 * 3. Standalone string: if the string itself matches CREDENTIAL_PATTERN, redact it.
 *
 * Objects and arrays are shallow-cloned so the original is never mutated.
 */
function redactCredentials(value: unknown, keyHint?: string): unknown {
  // If the parent key is a credential key, redact the whole value unconditionally.
  if (keyHint !== undefined && CREDENTIAL_PATTERN.test(keyHint)) {
    return REDACTED
  }

  if (typeof value === 'string') {
    return CREDENTIAL_PATTERN.test(value) ? REDACTED : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentials(item))
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactCredentials(v, k)
    }
    return result
  }
  return value
}

function sanitizeMcpServerEntry(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const entry = value as Record<string, unknown>
  const sanitized: Record<string, unknown> = { ...entry }
  delete sanitized['env']
  delete sanitized['headers']
  return sanitized
}

export function sanitizeRunMetadataForPersistence(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined

  // Drop entire top-level keys that hold structured credential objects.
  const sanitized: Record<string, unknown> = { ...metadata }
  for (const key of TOP_LEVEL_SECRET_METADATA_KEYS) {
    delete sanitized[key]
  }

  // Strip env/headers from every mcpServers entry.
  if (Array.isArray(sanitized['mcpServers'])) {
    sanitized['mcpServers'] = sanitized['mcpServers'].map(sanitizeMcpServerEntry)
  }

  // Recursively redact any remaining credential data — catches nested objects
  // such as { db: { password: "..." } } and array env var strings.
  return redactCredentials(sanitized) as Record<string, unknown>
}

export function sanitizeRunForResponse<T extends Run>(run: T): T {
  const metadata = sanitizeRunMetadataForPersistence(run.metadata ?? undefined)
  return {
    ...run,
    ...(metadata !== undefined ? { metadata } : { metadata: undefined }),
  }
}
