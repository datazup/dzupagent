import type { AdapterMiddleware } from './middleware-pipeline.js'

/**
 * Options for content sanitization.
 */
export interface ContentSanitizerConfig {
  /** Strip HTML tags from content. Default: true */
  stripHtml?: boolean
  /** Strip script-like content (javascript:, on*=, etc). Default: true */
  stripScripts?: boolean
  /** Max content length (truncate if exceeded). Default: undefined (no limit) */
  maxContentLength?: number
  /** Custom sanitizer function (applied after built-in sanitization) */
  customSanitizer?: (content: string) => string
}

/**
 * Sanitizes string content by stripping HTML tags, script injections, and event handlers.
 * Designed for safe rendering in web UIs.
 */
export function sanitizeContent(content: string, config?: ContentSanitizerConfig): string {
  let result = content

  if (config?.stripHtml !== false) {
    // Strip HTML tags
    result = result.replace(/<[^>]*>/g, '')
  }

  if (config?.stripScripts !== false) {
    // Strip javascript: protocol
    result = result.replace(/javascript\s*:/gi, '')
    // Strip on* event handlers (e.g., onerror=, onclick=)
    result = result.replace(/\bon\w+\s*=/gi, '')
    // Strip data: URIs with script content
    result = result.replace(/data\s*:\s*text\/html/gi, '')
  }

  if (config?.maxContentLength && result.length > config.maxContentLength) {
    result = result.slice(0, config.maxContentLength)
  }

  if (config?.customSanitizer) {
    result = config.customSanitizer(result)
  }

  return result
}

/**
 * Creates a middleware that sanitizes content in message and stream_delta events.
 * This protects against XSS when event content is rendered in a web UI.
 */
export function createContentSanitizerMiddleware(config?: ContentSanitizerConfig): AdapterMiddleware {
  return async function* contentSanitizer(source, _context) {
    for await (const event of source) {
      switch (event.type) {
        case 'adapter:message': {
          yield { ...event, content: sanitizeContent(event.content, config) }
          break
        }
        case 'adapter:stream_delta': {
          yield { ...event, content: sanitizeContent(event.content, config) }
          break
        }
        case 'adapter:completed': {
          yield { ...event, result: sanitizeContent(event.result, config) }
          break
        }
        default:
          yield event
      }
    }
  }
}
