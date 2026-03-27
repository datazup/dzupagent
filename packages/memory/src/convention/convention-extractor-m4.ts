/**
 * Convention Extraction from Memories (M4 Consolidation)
 *
 * Analyzes an array of MemoryEntry records to find recurring textual
 * patterns — API conventions, naming patterns, error-handling approaches,
 * etc.  When the same pattern appears in `threshold` or more memories
 * it is promoted to an ExtractedConvention.
 *
 * This is the *offline* / between-session counterpart to the existing
 * ConventionExtractor which works on live code files.  Both produce
 * compatible convention shapes.
 *
 * Algorithm:
 *   1. Normalize every memory text into a set of n-gram shingles
 *   2. Build an inverted index: shingle -> list of memory keys
 *   3. For each shingle that appears >= threshold times, cluster the
 *      memories sharing it
 *   4. Merge overlapping clusters (union-find) and emit one convention
 *      per cluster
 */
import type {
  MemoryEntry,
  ExtractedConvention,
  ConventionExtractionResult,
} from '../consolidation-types.js'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 3
const SHINGLE_SIZE = 3 // 3-word shingles
const MIN_SHINGLE_WORD_LEN = 2 // skip single-char words

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate n-gram shingles from text.
 * e.g. "always use camelCase for variables" with n=3 yields:
 *   "always use camelcase", "use camelcase for", "camelcase for variables"
 */
function generateShingles(text: string, n: number): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= MIN_SHINGLE_WORD_LEN)

  if (words.length < n) return words.length > 0 ? [words.join(' ')] : []

  const shingles: string[] = []
  for (let i = 0; i <= words.length - n; i++) {
    shingles.push(words.slice(i, i + n).join(' '))
  }
  return shingles
}

/**
 * Infer a convention category from representative text.
 * Best-effort keyword matching.
 */
function inferCategory(text: string): string {
  const lower = text.toLowerCase()
  if (/\b(camelcase|pascalcase|snake_case|kebab|naming)\b/.test(lower)) return 'naming'
  if (/\b(import|export|require|module)\b/.test(lower)) return 'imports'
  if (/\b(try|catch|error|throw|exception)\b/.test(lower)) return 'error-handling'
  if (/\b(type|interface|generic|zod|schema)\b/.test(lower)) return 'typing'
  if (/\b(test|spec|describe|it\(|expect)\b/.test(lower)) return 'testing'
  if (/\b(endpoint|route|api|rest|graphql|middleware)\b/.test(lower)) return 'api'
  if (/\b(query|prisma|sql|database|migration)\b/.test(lower)) return 'database'
  if (/\b(css|tailwind|class|style)\b/.test(lower)) return 'styling'
  if (/\b(folder|directory|structure|layout|file)\b/.test(lower)) return 'structure'
  return 'general'
}

/**
 * Simple union-find for merging overlapping clusters.
 */
class UnionFind {
  private parent: number[]
  private rank: number[]

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.rank = new Array<number>(n).fill(0)
  }

  find(x: number): number {
    let root = x
    while (this.parent[root] !== root) {
      root = this.parent[root]!
    }
    // Path compression
    let curr = x
    while (curr !== root) {
      const next = this.parent[curr]!
      this.parent[curr] = root
      curr = next
    }
    return root
  }

  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    const rankA = this.rank[ra]!
    const rankB = this.rank[rb]!
    if (rankA < rankB) {
      this.parent[ra] = rb
    } else if (rankA > rankB) {
      this.parent[rb] = ra
    } else {
      this.parent[rb] = ra
      this.rank[ra] = rankA + 1
    }
  }
}

/**
 * Generate a deterministic id from the representative text.
 */
function makeConventionId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1)
    .slice(0, 5)
    .join('-')
  return `mem-conv-${slug || 'unknown'}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract conventions from an array of memory entries.
 *
 * Finds recurring textual patterns across memories using n-gram shingle
 * matching.  When `threshold` or more memories share a shingle cluster,
 * a convention is emitted.
 *
 * @param memories  - Array of MemoryEntry to analyze
 * @param threshold - Minimum occurrences to promote to convention (default: 3)
 * @returns ConventionExtractionResult with extracted conventions
 */
export function extractConventions(
  memories: MemoryEntry[],
  threshold: number = DEFAULT_THRESHOLD,
): ConventionExtractionResult {
  if (memories.length === 0) {
    return { conventions: [], memoriesAnalyzed: 0 }
  }

  // Step 1: Build shingles per memory, and an inverted index
  const memoryShingles: string[][] = memories.map(m => generateShingles(m.text, SHINGLE_SIZE))
  const invertedIndex = new Map<string, number[]>()

  for (let i = 0; i < memoryShingles.length; i++) {
    const shingles = memoryShingles[i]!
    const seen = new Set<string>() // dedupe per-memory
    for (const sh of shingles) {
      if (seen.has(sh)) continue
      seen.add(sh)
      const list = invertedIndex.get(sh)
      if (list) {
        list.push(i)
      } else {
        invertedIndex.set(sh, [i])
      }
    }
  }

  // Step 2: Find shingles that appear >= threshold times
  const frequentShingles: Array<{ shingle: string; indices: number[] }> = []
  for (const [shingle, indices] of invertedIndex) {
    if (indices.length >= threshold) {
      frequentShingles.push({ shingle, indices })
    }
  }

  if (frequentShingles.length === 0) {
    return { conventions: [], memoriesAnalyzed: memories.length }
  }

  // Step 3: Merge overlapping clusters using union-find on memory indices
  const uf = new UnionFind(memories.length)
  for (const { indices } of frequentShingles) {
    const first = indices[0]!
    for (let i = 1; i < indices.length; i++) {
      uf.union(first, indices[i]!)
    }
  }

  // Build clusters
  const clusters = new Map<number, number[]>()
  for (let i = 0; i < memories.length; i++) {
    // Only include memories that participate in at least one frequent shingle
    let participates = false
    for (const { indices } of frequentShingles) {
      if (indices.includes(i)) {
        participates = true
        break
      }
    }
    if (!participates) continue

    const root = uf.find(i)
    const list = clusters.get(root)
    if (list) {
      list.push(i)
    } else {
      clusters.set(root, [i])
    }
  }

  // Step 4: Emit conventions from clusters meeting the threshold
  const conventions: ExtractedConvention[] = []
  const seenIds = new Set<string>()

  for (const [_root, indices] of clusters) {
    if (indices.length < threshold) continue

    // Collect the memory entries in this cluster
    const clusterEntries = indices.map(i => memories[i]!)

    // Find the most frequent shingle for this cluster (as the representative pattern)
    let bestShingle = ''
    let bestCount = 0
    for (const { shingle, indices: shIndices } of frequentShingles) {
      const overlap = shIndices.filter(i => indices.includes(i)).length
      if (overlap > bestCount) {
        bestCount = overlap
        bestShingle = shingle
      }
    }

    // Pick the longest entry text as representative
    const sorted = [...clusterEntries].sort((a, b) => b.text.length - a.text.length)
    const representative = sorted[0]!

    const category = inferCategory(representative.text)
    let id = makeConventionId(bestShingle || representative.text)

    // Ensure unique ids
    let suffix = 0
    const baseId = id
    while (seenIds.has(id)) {
      suffix++
      id = `${baseId}-${suffix}`
    }
    seenIds.add(id)

    conventions.push({
      id,
      name: bestShingle || representative.text.slice(0, 60),
      category,
      description: `Pattern observed ${indices.length} times: "${bestShingle || representative.text.slice(0, 80)}"`,
      examples: sorted.slice(0, 3).map(e => e.text.slice(0, 200)),
      occurrences: indices.length,
      confidence: Math.min(1, indices.length / (threshold * 2)),
      sourceKeys: clusterEntries.map(e => e.key),
    })
  }

  // Sort by occurrence count (most frequent first)
  conventions.sort((a, b) => b.occurrences - a.occurrences)

  return {
    conventions,
    memoriesAnalyzed: memories.length,
  }
}
