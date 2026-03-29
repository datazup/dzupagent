/**
 * Check if a URL uses hash-based routing (e.g., /#/dashboard, /#!/settings).
 * Hash routes are used by older SPAs (Vue Router hash mode, Angular.js, etc.).
 */
export function isHashRoute(url: string): boolean {
  try {
    const parsed = new URL(url)
    // Match /#/ or /#!/ patterns — these indicate SPA hash routing
    return /^#[!/]/.test(parsed.hash)
  } catch {
    return false
  }
}

/**
 * Normalize a URL for deduplication and queuing.
 * Preserves hash fragments that represent SPA routes (/#/path),
 * but strips plain anchors (#section-id).
 */
export function normalizeUrl(url: string, baseUrl: string): string | null {
  try {
    const parsed = new URL(url, baseUrl)

    if (isHashRoute(parsed.href)) {
      // Preserve hash route but strip any nested anchor within it
      // e.g., /#/page#section → /#/page
      const hashPath = parsed.hash.replace(/#[!/]/, '')
      const nestedAnchorIdx = hashPath.indexOf('#')
      if (nestedAnchorIdx !== -1) {
        parsed.hash = parsed.hash.slice(0, parsed.hash.indexOf('#', 2))
      }
    } else {
      // Regular URL — strip hash (plain anchors)
      parsed.hash = ''
    }

    let normalized = parsed.href
    if (normalized.endsWith('/') && parsed.pathname !== '/') {
      normalized = normalized.slice(0, -1)
    }
    return normalized
  } catch {
    return null
  }
}

export function isSameOrigin(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url)
    const b = new URL(baseUrl)
    return a.origin === b.origin
  } catch {
    return false
  }
}

export function matchesPattern(url: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    // Convert glob-like pattern to regex
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    )
    return regex.test(url)
  })
}
