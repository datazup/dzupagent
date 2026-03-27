/**
 * Capability matching utilities.
 *
 * Provides hierarchy-aware scoring and wildcard pattern matching
 * for agent capability discovery.
 */

// ---------------------------------------------------------------------------
// Semver comparison (S7 fix: numeric, not lexicographic)
// ---------------------------------------------------------------------------

/**
 * Compare two semver strings numerically.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 *
 * Only handles major.minor.patch — no pre-release or build metadata.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  const len = Math.max(partsA.length, partsB.length)

  for (let i = 0; i < len; i++) {
    const numA = partsA[i] ?? 0
    const numB = partsB[i] ?? 0
    if (numA < numB) return -1
    if (numA > numB) return 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// CapabilityMatcher
// ---------------------------------------------------------------------------

/**
 * Scores how well capabilities match queries using hierarchy-aware logic.
 *
 * Scoring rules:
 * - Exact match: 1.0
 * - Candidate is a child of query (e.g. query="code.review", candidate="code.review.security"): 0.8
 * - Candidate is a parent of query (e.g. query="code.review.security", candidate="code.review"): 0.5
 * - No relationship: 0
 */
export class CapabilityMatcher {
  /**
   * Score how well a candidate capability matches a query.
   * Returns 0..1.
   */
  match(query: string, candidate: string): number {
    if (query === candidate) return 1.0

    const queryParts = query.split('.')
    const candidateParts = candidate.split('.')

    // Check if one is a prefix of the other
    const minLen = Math.min(queryParts.length, candidateParts.length)
    let prefixMatch = true
    for (let i = 0; i < minLen; i++) {
      if (queryParts[i] !== candidateParts[i]) {
        prefixMatch = false
        break
      }
    }

    if (!prefixMatch) return 0

    // Candidate is more specific than query (child match)
    if (candidateParts.length > queryParts.length) {
      const depthDiff = candidateParts.length - queryParts.length
      return Math.max(0.5, 1.0 - depthDiff * 0.2)
    }

    // Candidate is less specific than query (parent match)
    if (queryParts.length > candidateParts.length) {
      const depthDiff = queryParts.length - candidateParts.length
      return Math.max(0.3, 0.6 - depthDiff * 0.1)
    }

    return 0
  }

  /**
   * Check if a capability matches a wildcard pattern.
   * "code.*" matches "code.review", "code.review.security", etc.
   * "code.review.*" matches "code.review.security" but not "code.generate".
   */
  matchesPattern(pattern: string, capability: string): boolean {
    if (pattern === capability) return true

    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2)
      return capability === prefix || capability.startsWith(prefix + '.')
    }

    // No wildcard — exact match only
    return pattern === capability
  }
}
