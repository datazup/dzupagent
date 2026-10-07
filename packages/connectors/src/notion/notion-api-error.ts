/**
 * Notion REST API — error type and secret redaction.
 */

export class NotionApiError extends Error {
  readonly status: number
  /** Notion error code (e.g. `object_not_found`), or `unknown` for non-JSON bodies. */
  readonly code: string
  /** Response body with secrets redacted. */
  readonly body: string

  constructor(status: number, body: string, secrets: readonly string[] = []) {
    const redactedBody = redactNotionSecrets(body, secrets)
    const parsed = parseNotionError(redactedBody)
    const detail = parsed.message ?? redactedBody.slice(0, 200)
    super(`Notion API error ${status} ${parsed.code}: ${detail}`)
    this.name = 'NotionApiError'
    this.status = status
    this.code = parsed.code
    this.body = redactedBody
  }
}

function parseNotionError(body: string): { code: string; message?: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object') {
      const { code, message } = parsed as Record<string, unknown>
      return {
        code: typeof code === 'string' ? code : 'unknown',
        ...(typeof message === 'string' ? { message } : {}),
      }
    }
  } catch {
    // Non-JSON body (e.g. a gateway HTML page).
  }
  return { code: 'unknown' }
}

export function redactNotionSecrets(value: string, secrets: readonly string[] = []): string {
  let redacted = value
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:secret|ntn)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_NOTION_TOKEN]')
}
