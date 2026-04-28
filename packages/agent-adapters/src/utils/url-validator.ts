/**
 * Webhook URL SSRF protection utilities.
 *
 * Validates webhook URLs to prevent Server-Side Request Forgery (SSRF) attacks
 * by blocking private IP ranges, cloud metadata endpoints, and other dangerous
 * destinations.
 */

import { ForgeError, validateOutboundUrlSyntax } from '@dzupagent/core'

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
  const result = validateOutboundUrlSyntax(url, {
    allowHttp: options?.allowHttp,
    allowedHosts: options?.allowedHosts,
    blockedHosts: options?.blockedHosts,
  })
  if (!result.ok) {
    throw new ForgeError({
      code: 'VALIDATION_FAILED',
      message: `Webhook URL blocked: ${result.reason}`,
      recoverable: false,
    })
  }
}
