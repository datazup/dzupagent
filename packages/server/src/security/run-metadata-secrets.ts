import type { Run } from '@dzupagent/core'

const TOP_LEVEL_SECRET_METADATA_KEYS = new Set([
  'githubToken',
  'slackToken',
  'httpHeaders',
  'httpAuthorization',
  'httpBearerToken',
  'mcpEnv',
  'mcpHeaders',
])

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

  const sanitized: Record<string, unknown> = { ...metadata }
  for (const key of TOP_LEVEL_SECRET_METADATA_KEYS) {
    delete sanitized[key]
  }

  if (Array.isArray(sanitized['mcpServers'])) {
    sanitized['mcpServers'] = sanitized['mcpServers'].map(sanitizeMcpServerEntry)
  }

  return sanitized
}

export function sanitizeRunForResponse<T extends Run>(run: T): T {
  const metadata = sanitizeRunMetadataForPersistence(run.metadata ?? undefined)
  return {
    ...run,
    ...(metadata !== undefined ? { metadata } : { metadata: undefined }),
  }
}
