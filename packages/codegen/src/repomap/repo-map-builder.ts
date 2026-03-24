/**
 * Build a token-budgeted condensed repository map.
 *
 * Inspired by Aider's repo-map: produces a ranked, budget-aware
 * markdown summary of the most important symbols in a codebase.
 */

import * as path from 'node:path'
import { extractSymbols, type ExtractedSymbol } from './symbol-extractor.js'
import { buildImportGraph } from './import-graph.js'

export interface RepoMapConfig {
  /** Maximum tokens for the output map (default: 4000) */
  maxTokens: number
  /** Focus files that get priority (e.g., files being edited) */
  focusFiles?: string[]
  /** Files to exclude (glob patterns converted to simple substring checks) */
  excludePatterns?: string[]
}

export interface RepoMap {
  /** The condensed map as a markdown string */
  content: string
  /** Total symbols included */
  symbolCount: number
  /** Total files included */
  fileCount: number
  /** Estimated tokens used */
  estimatedTokens: number
}

const DEFAULT_CONFIG: RepoMapConfig = {
  maxTokens: 4000,
  focusFiles: [],
  excludePatterns: [],
}

/** Kind weight: classes/interfaces rank higher than functions/types/consts */
const KIND_WEIGHTS: Record<ExtractedSymbol['kind'], number> = {
  class: 3,
  interface: 3,
  function: 2,
  enum: 2,
  type: 1,
  const: 1,
}

interface ScoredSymbol {
  symbol: ExtractedSymbol
  score: number
}

/**
 * Check if a file path matches any exclude pattern.
 * Patterns are treated as substring matches for simplicity.
 */
function isExcluded(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => filePath.includes(p))
}

/**
 * Estimate token count from a string (chars / 4 is a common heuristic).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Build a condensed repository map within a token budget.
 *
 * Scoring: symbols are ranked by importance:
 * - Exported (+3)
 * - Referenced by other files (+1 per reference)
 * - In focus files (+5)
 * - Classes/interfaces > functions > types > consts
 */
export function buildRepoMap(
  files: Array<{ path: string; content: string }>,
  config?: Partial<RepoMapConfig>,
): RepoMap {
  const cfg: RepoMapConfig = { ...DEFAULT_CONFIG, ...config }
  const excludePatterns = cfg.excludePatterns ?? []
  const focusFiles = new Set(cfg.focusFiles ?? [])

  // 1. Filter out excluded files
  const included = files.filter((f) => !isExcluded(f.path, excludePatterns))

  // 2. Extract symbols from all files
  const allSymbols: ExtractedSymbol[] = []
  for (const file of included) {
    const syms = extractSymbols(file.path, file.content)
    allSymbols.push(...syms)
  }

  if (allSymbols.length === 0) {
    return { content: '', symbolCount: 0, fileCount: 0, estimatedTokens: 0 }
  }

  // 3. Build import graph and count references per file
  const rootDir = findCommonRoot(included.map((f) => f.path))
  const graph = buildImportGraph(included, rootDir)

  // Count how many other files import each file
  const importerCount = new Map<string, number>()
  for (const edge of graph.edges) {
    const current = importerCount.get(edge.to) ?? 0
    importerCount.set(edge.to, current + 1)
  }

  // 4. Score each symbol
  const scored: ScoredSymbol[] = allSymbols.map((symbol) => {
    let score = KIND_WEIGHTS[symbol.kind]

    if (symbol.exported) score += 3

    // Reference count: how many files import this file
    const absPath = path.resolve(rootDir, symbol.filePath)
    const refs = importerCount.get(absPath) ?? 0
    score += refs

    // Focus file bonus
    if (focusFiles.has(symbol.filePath)) score += 5

    return { symbol, score }
  })

  // 5. Sort by score descending, then by file path for stability
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const pathCmp = a.symbol.filePath.localeCompare(b.symbol.filePath)
    if (pathCmp !== 0) return pathCmp
    return a.symbol.line - b.symbol.line
  })

  // 6. Build markdown output within token budget
  // Group symbols by file, preserving score-based ordering
  const fileOrder: string[] = []
  const fileSymbols = new Map<string, ScoredSymbol[]>()
  const seenFiles = new Set<string>()

  for (const entry of scored) {
    const fp = entry.symbol.filePath
    if (!seenFiles.has(fp)) {
      seenFiles.add(fp)
      fileOrder.push(fp)
      fileSymbols.set(fp, [])
    }
    fileSymbols.get(fp)!.push(entry)
  }

  const lines: string[] = []
  let currentTokens = 0
  let symbolCount = 0
  const includedFiles = new Set<string>()
  const budget = cfg.maxTokens

  for (const fp of fileOrder) {
    const syms = fileSymbols.get(fp)!
    // Build the file header
    const header = `\n## ${fp}\n`
    const headerTokens = estimateTokens(header)

    // Check if we can at least fit the header + one symbol
    if (currentTokens + headerTokens >= budget) break

    const symbolLines: string[] = []
    let sectionTokens = headerTokens

    for (const { symbol } of syms) {
      const prefix = symbol.exported ? 'export ' : ''
      const line = `- ${prefix}${symbol.signature}`
      const lineTokens = estimateTokens(line + '\n')

      if (currentTokens + sectionTokens + lineTokens > budget) break

      symbolLines.push(line)
      sectionTokens += lineTokens
      symbolCount++
    }

    if (symbolLines.length > 0) {
      lines.push(header.trimStart())
      lines.push(...symbolLines)
      currentTokens += sectionTokens
      includedFiles.add(fp)
    }

    if (currentTokens >= budget) break
  }

  const content = lines.join('\n')
  return {
    content,
    symbolCount,
    fileCount: includedFiles.size,
    estimatedTokens: estimateTokens(content),
  }
}

/**
 * Find the common root directory of a set of file paths.
 */
function findCommonRoot(paths: string[]): string {
  if (paths.length === 0) return '.'
  if (paths.length === 1) return path.dirname(paths[0]!)

  const segments = paths.map((p) => path.resolve(p).split(path.sep))
  const first = segments[0]!
  let commonLength = 0

  for (let i = 0; i < first.length; i++) {
    const seg = first[i]
    if (segments.every((s) => s[i] === seg)) {
      commonLength = i + 1
    } else {
      break
    }
  }

  return first.slice(0, commonLength).join(path.sep) || '.'
}
