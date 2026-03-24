/**
 * In-memory full-text search using TF-IDF-like keyword scoring.
 * Works on the `text` field of memory records. Zero external dependencies.
 */

export interface FTSSearchResult {
  key: string
  score: number
  value: Record<string, unknown>
}

interface FTSRecord {
  key: string
  value: Record<string, unknown>
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'it', 'in', 'on', 'of', 'to', 'and', 'or', 'for', 'with', 'as', 'at', 'by',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t))
}

function getRecordText(value: Record<string, unknown>): string {
  if (typeof value['text'] === 'string') return value['text']
  if (typeof value['content'] === 'string') return value['content']
  return JSON.stringify(value)
}

/**
 * In-memory full-text search using keyword matching with term frequency scoring.
 */
export class KeywordFTSSearch {
  /**
   * Search records by keyword relevance.
   * Tokenizes query and records, scores by fraction of query terms found
   * weighted by term frequency in the document.
   */
  search(records: FTSRecord[], query: string, limit: number): FTSSearchResult[] {
    const queryTerms = tokenize(query)
    if (queryTerms.length === 0) return []

    const totalDocs = records.length
    // Compute inverse document frequency for each query term
    const docFreq = new Map<string, number>()
    const docTokensCache = new Map<string, string[]>()

    for (const rec of records) {
      const tokens = tokenize(getRecordText(rec.value))
      docTokensCache.set(rec.key, tokens)
      const uniqueTokens = new Set(tokens)
      for (const qt of queryTerms) {
        if (uniqueTokens.has(qt)) {
          docFreq.set(qt, (docFreq.get(qt) ?? 0) + 1)
        }
      }
    }

    const scored: FTSSearchResult[] = []

    for (const rec of records) {
      const tokens = docTokensCache.get(rec.key) ?? []
      if (tokens.length === 0) continue

      let score = 0
      for (const qt of queryTerms) {
        const tf = tokens.filter(t => t === qt).length / tokens.length
        const df = docFreq.get(qt) ?? 0
        const idf = df > 0 ? Math.log(1 + totalDocs / df) : 0
        score += tf * idf
      }

      if (score > 0) {
        scored.push({ key: rec.key, score, value: rec.value })
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }
}
