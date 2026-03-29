import type { ExtractionConfig } from './types.js'

/** Metadata extracted from HTML */
export interface ExtractedContent {
  text: string
  title?: string
  description?: string
  author?: string
  publishedDate?: string
}

const DEFAULT_CONFIG: ExtractionConfig = {
  mode: 'text',
  cleanHtml: true,
}

/**
 * Extracts clean text and metadata from raw HTML.
 *
 * Uses regex-based parsing (no DOM library dependency) to strip noise
 * elements and extract readable content.
 */
export class ContentExtractor {
  /**
   * Extract clean text and metadata from HTML.
   */
  extract(html: string, options?: Partial<ExtractionConfig>): ExtractedContent {
    const config = { ...DEFAULT_CONFIG, ...options }
    const title = this.extractTitle(html)
    const description = this.extractMetaContent(html, 'description')
    const author =
      this.extractMetaContent(html, 'author') ??
      this.extractMetaProperty(html, 'article:author')
    const publishedDate =
      this.extractMetaProperty(html, 'article:published_time') ??
      this.extractMetaContent(html, 'date') ??
      this.extractMetaProperty(html, 'og:published_time')

    let text = ''

    if (config.mode === 'metadata') {
      // Metadata-only mode: no text extraction
      return { text: '', title, description, author, publishedDate }
    }

    if (config.cleanHtml) {
      text = this.extractCleanText(html)
    } else {
      text = this.stripAllTags(html)
    }

    if (config.maxLength && text.length > config.maxLength) {
      text = text.slice(0, config.maxLength)
    }

    return { text, title, description, author, publishedDate }
  }

  /** Extract the page title from <title> or first <h1> */
  private extractTitle(html: string): string | undefined {
    // Try <title> tag first
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (titleMatch?.[1]) {
      const decoded = this.decodeEntities(titleMatch[1].trim())
      if (decoded) return decoded
    }

    // Fall back to first <h1>
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    if (h1Match?.[1]) {
      return this.decodeEntities(this.stripAllTags(h1Match[1]).trim()) || undefined
    }

    return undefined
  }

  /** Extract content from a <meta name="..."> tag */
  private extractMetaContent(html: string, name: string): string | undefined {
    // Match both name="..." content="..." and content="..." name="..." orders
    const pattern1 = new RegExp(
      `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["'][^>]*/?>`,
      'i',
    )
    const pattern2 = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["'][^>]*/?>`,
      'i',
    )

    const match = html.match(pattern1) ?? html.match(pattern2)
    const value = match?.[1]?.trim()
    return value || undefined
  }

  /** Extract content from a <meta property="..."> tag (Open Graph etc.) */
  private extractMetaProperty(html: string, property: string): string | undefined {
    const pattern1 = new RegExp(
      `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["'][^>]*/?>`,
      'i',
    )
    const pattern2 = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["'][^>]*/?>`,
      'i',
    )

    const match = html.match(pattern1) ?? html.match(pattern2)
    const value = match?.[1]?.trim()
    return value || undefined
  }

  /** Remove noise elements and extract readable text */
  private extractCleanText(html: string): string {
    let cleaned = html

    // Remove comments
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '')

    // Remove entire noise elements (script, style, nav, header, footer, aside, iframe, svg)
    const noiseElements = [
      'script',
      'style',
      'noscript',
      'nav',
      'header',
      'footer',
      'aside',
      'iframe',
      'svg',
      'form',
    ]
    for (const tag of noiseElements) {
      const tagPattern = new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi')
      cleaned = cleaned.replace(tagPattern, '')
      // Also remove self-closing variants
      const selfClosing = new RegExp(`<${tag}[^>]*/?>`, 'gi')
      cleaned = selfClosing.test(cleaned)
        ? cleaned.replace(selfClosing, '')
        : cleaned
    }

    // Remove hidden elements (display:none, hidden attribute)
    cleaned = cleaned.replace(/<[^>]+(?:display\s*:\s*none|hidden)[^>]*>[\s\S]*?<\/[^>]+>/gi, '')

    // Add newlines before block elements for readability
    cleaned = cleaned.replace(/<\/?(?:div|p|br|h[1-6]|li|tr|blockquote|section|article)\b[^>]*\/?>/gi, '\n')

    // Strip remaining tags
    cleaned = this.stripAllTags(cleaned)

    // Decode HTML entities
    cleaned = this.decodeEntities(cleaned)

    // Collapse whitespace: multiple spaces to one, multiple newlines to two
    cleaned = cleaned
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')

    // Collapse runs of 3+ newlines into 2
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n')

    return cleaned.trim()
  }

  /** Strip all HTML tags from a string */
  private stripAllTags(html: string): string {
    return html.replace(/<[^>]*>/g, '')
  }

  /** Decode common HTML entities */
  private decodeEntities(text: string): string {
    const entities: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&apos;': "'",
      '&nbsp;': ' ',
      '&mdash;': '\u2014',
      '&ndash;': '\u2013',
      '&laquo;': '\u00AB',
      '&raquo;': '\u00BB',
      '&hellip;': '\u2026',
      '&copy;': '\u00A9',
      '&reg;': '\u00AE',
      '&trade;': '\u2122',
    }

    let result = text
    for (const [entity, char] of Object.entries(entities)) {
      result = result.replaceAll(entity, char)
    }

    // Decode numeric entities (&#123; and &#x1F;)
    result = result.replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(Number(code)),
    )
    result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex as string, 16)),
    )

    return result
  }
}
