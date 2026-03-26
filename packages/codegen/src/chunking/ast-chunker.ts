/**
 * AST-boundary-aware code chunker for embedding-ready splits.
 *
 * Splits source files at function/class/method boundaries using tree-sitter
 * AST data. Falls back to line-based splitting when tree-sitter is unavailable.
 */

import { extractSymbolsAST, detectLanguage, type ASTSymbol } from '../repomap/tree-sitter-extractor.js'

// -----------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------

/** A code chunk with AST-aware boundaries */
export interface CodeChunk {
  /** Unique identifier: filePath#symbolName or filePath#L{start}-L{end} */
  id: string
  /** File this chunk belongs to */
  filePath: string
  /** The source code of the chunk */
  content: string
  /** Start line (1-indexed) */
  startLine: number
  /** End line (1-indexed) */
  endLine: number
  /** Symbols contained in this chunk */
  symbols: ASTSymbol[]
  /** Language of the source file */
  language: string
  /** Estimated token count */
  estimatedTokens: number
}

/** Configuration for the AST chunker */
export interface ASTChunkerConfig {
  /** Maximum tokens per chunk (default: 512) */
  maxChunkTokens?: number
  /** Minimum tokens per chunk to avoid tiny fragments (default: 64) */
  minChunkTokens?: number
  /** Overlap lines between adjacent chunks (default: 2) */
  overlapLines?: number
}

// -----------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------

const DEFAULT_CONFIG: Required<ASTChunkerConfig> = {
  maxChunkTokens: 512,
  minChunkTokens: 64,
  overlapLines: 2,
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Estimate token count (chars / 4 heuristic, same as repo-map-builder). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Extract lines [start, end] from content (1-indexed, inclusive). */
function extractLines(lines: string[], start: number, end: number): string {
  // Clamp to valid range
  const s = Math.max(0, start - 1)
  const e = Math.min(lines.length, end)
  return lines.slice(s, e).join('\n')
}

/**
 * Build a chunk ID from a file path and symbol/line info.
 */
function chunkId(filePath: string, symbols: ASTSymbol[], startLine: number, endLine: number): string {
  if (symbols.length === 1 && symbols[0]) {
    return `${filePath}#${symbols[0].name}`
  }
  return `${filePath}#L${startLine}-L${endLine}`
}

// -----------------------------------------------------------------------
// Symbol-based chunking
// -----------------------------------------------------------------------

interface SymbolRange {
  symbol: ASTSymbol
  startLine: number
  endLine: number
}

/**
 * Get top-level symbol ranges (not nested inside other symbols).
 * A symbol is top-level if it has no parent.
 */
function getTopLevelRanges(symbols: ASTSymbol[]): SymbolRange[] {
  const topLevel = symbols.filter((s) => !s.parent)
  return topLevel.map((s) => ({
    symbol: s,
    startLine: s.line,
    endLine: s.endLine,
  }))
}

/**
 * Get child symbols for a given parent name.
 */
function getChildren(symbols: ASTSymbol[], parentName: string): ASTSymbol[] {
  return symbols.filter((s) => s.parent === parentName)
}

/**
 * Split a large symbol at its child boundaries (e.g., split a class at method boundaries).
 */
function splitLargeSymbol(
  parent: SymbolRange,
  allSymbols: ASTSymbol[],
  lines: string[],
  cfg: Required<ASTChunkerConfig>,
  filePath: string,
  language: string,
): CodeChunk[] {
  const children = getChildren(allSymbols, parent.symbol.name)
  if (children.length === 0) {
    // No children to split by -- return as a single chunk even if large
    const content = extractLines(lines, parent.startLine, parent.endLine)
    return [{
      id: chunkId(filePath, [parent.symbol], parent.startLine, parent.endLine),
      filePath,
      content,
      startLine: parent.startLine,
      endLine: parent.endLine,
      symbols: [parent.symbol],
      language,
      estimatedTokens: estimateTokens(content),
    }]
  }

  const chunks: CodeChunk[] = []
  // Include the class/interface header as its own chunk
  const firstChild = children[0]
  if (firstChild && firstChild.line > parent.startLine) {
    const headerEnd = firstChild.line - 1
    const content = extractLines(lines, parent.startLine, headerEnd)
    const tokens = estimateTokens(content)
    if (tokens >= cfg.minChunkTokens) {
      chunks.push({
        id: `${filePath}#${parent.symbol.name}:header`,
        filePath,
        content,
        startLine: parent.startLine,
        endLine: headerEnd,
        symbols: [parent.symbol],
        language,
        estimatedTokens: tokens,
      })
    }
  }

  // Each child method/property becomes a chunk
  for (const child of children) {
    const content = extractLines(lines, child.line, child.endLine)
    chunks.push({
      id: `${filePath}#${parent.symbol.name}.${child.name}`,
      filePath,
      content,
      startLine: child.line,
      endLine: child.endLine,
      symbols: [child],
      language,
      estimatedTokens: estimateTokens(content),
    })
  }

  return chunks
}

// -----------------------------------------------------------------------
// Merge small chunks
// -----------------------------------------------------------------------

/**
 * Merge adjacent chunks that are below the minimum token threshold.
 */
function mergeSmallChunks(
  chunks: CodeChunk[],
  cfg: Required<ASTChunkerConfig>,
  filePath: string,
  language: string,
  lines: string[],
): CodeChunk[] {
  if (chunks.length <= 1) return chunks

  const merged: CodeChunk[] = []
  let accumulator: CodeChunk | null = null

  for (const chunk of chunks) {
    if (!accumulator) {
      accumulator = { ...chunk, symbols: [...chunk.symbols] }
      continue
    }

    // If accumulator is below minimum, merge with current chunk
    if (accumulator.estimatedTokens < cfg.minChunkTokens) {
      const mergedContent = extractLines(lines, accumulator.startLine, chunk.endLine)
      accumulator = {
        id: chunkId(filePath, [...accumulator.symbols, ...chunk.symbols], accumulator.startLine, chunk.endLine),
        filePath,
        content: mergedContent,
        startLine: accumulator.startLine,
        endLine: chunk.endLine,
        symbols: [...accumulator.symbols, ...chunk.symbols],
        language,
        estimatedTokens: estimateTokens(mergedContent),
      }
    } else {
      merged.push(accumulator)
      accumulator = { ...chunk, symbols: [...chunk.symbols] }
    }
  }

  if (accumulator) {
    merged.push(accumulator)
  }

  return merged
}

// -----------------------------------------------------------------------
// Line-based fallback chunking
// -----------------------------------------------------------------------

/**
 * Split code into chunks by line count when AST is not available.
 */
function chunkByLines(
  filePath: string,
  content: string,
  language: string,
  cfg: Required<ASTChunkerConfig>,
): CodeChunk[] {
  const lines = content.split('\n')
  const maxLines = Math.max(10, Math.floor(cfg.maxChunkTokens / 4)) // rough estimate: ~4 tokens/line
  const chunks: CodeChunk[] = []

  for (let i = 0; i < lines.length; i += maxLines - cfg.overlapLines) {
    const start = i + 1
    const end = Math.min(i + maxLines, lines.length)
    const chunkContent = extractLines(lines, start, end)
    const tokens = estimateTokens(chunkContent)

    if (tokens > 0) {
      chunks.push({
        id: `${filePath}#L${start}-L${end}`,
        filePath,
        content: chunkContent,
        startLine: start,
        endLine: end,
        symbols: [],
        language,
        estimatedTokens: tokens,
      })
    }

    if (end >= lines.length) break
  }

  return chunks
}

// -----------------------------------------------------------------------
// Add overlap
// -----------------------------------------------------------------------

/**
 * Add overlap lines at chunk boundaries for context continuity.
 */
function addOverlap(
  chunks: CodeChunk[],
  lines: string[],
  overlapLines: number,
  filePath: string,
): CodeChunk[] {
  if (overlapLines <= 0 || chunks.length <= 1) return chunks

  return chunks.map((chunk, idx) => {
    let startLine = chunk.startLine
    const endLine = chunk.endLine

    // Add leading overlap from previous chunk (except for first chunk)
    if (idx > 0) {
      startLine = Math.max(1, startLine - overlapLines)
    }

    const content = extractLines(lines, startLine, endLine)
    return {
      ...chunk,
      content,
      startLine,
      estimatedTokens: estimateTokens(content),
      // Keep original id based on symbol boundaries
      id: chunk.id.includes('#L')
        ? `${filePath}#L${startLine}-L${endLine}`
        : chunk.id,
    }
  })
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Split source files into embedding-ready chunks using AST boundaries.
 *
 * Strategy:
 * 1. Parse file with tree-sitter to get symbol boundaries
 * 2. Each top-level symbol (class, function, interface) becomes a chunk
 * 3. Large symbols are split at nested boundaries (methods within classes)
 * 4. Small adjacent symbols are merged to meet minChunkTokens
 * 5. Falls back to line-based splitting if tree-sitter is unavailable
 *
 * @param filePath - File path (for language detection and chunk IDs)
 * @param content - Source code to chunk
 * @param config - Chunking parameters
 */
export async function chunkByAST(
  filePath: string,
  content: string,
  config?: ASTChunkerConfig,
): Promise<CodeChunk[]> {
  const cfg: Required<ASTChunkerConfig> = { ...DEFAULT_CONFIG, ...config }
  const language = detectLanguage(filePath) ?? 'unknown'
  const lines = content.split('\n')

  if (lines.length === 0 || content.trim() === '') {
    return []
  }

  // Try AST-based extraction
  const symbols = await extractSymbolsAST(filePath, content)

  if (symbols.length === 0) {
    // No symbols found (tree-sitter unavailable or no recognized symbols)
    return chunkByLines(filePath, content, language, cfg)
  }

  // Get top-level symbol ranges
  const topRanges = getTopLevelRanges(symbols)

  if (topRanges.length === 0) {
    return chunkByLines(filePath, content, language, cfg)
  }

  // Build chunks from symbol ranges
  let chunks: CodeChunk[] = []

  // Add any leading code before the first symbol (imports, comments)
  const firstRange = topRanges[0]
  if (firstRange && firstRange.startLine > 1) {
    const preambleContent = extractLines(lines, 1, firstRange.startLine - 1)
    const preambleTokens = estimateTokens(preambleContent)
    if (preambleTokens > 0) {
      chunks.push({
        id: `${filePath}#preamble`,
        filePath,
        content: preambleContent,
        startLine: 1,
        endLine: firstRange.startLine - 1,
        symbols: [],
        language,
        estimatedTokens: preambleTokens,
      })
    }
  }

  // Process each top-level symbol
  for (const range of topRanges) {
    const rangeContent = extractLines(lines, range.startLine, range.endLine)
    const rangeTokens = estimateTokens(rangeContent)

    if (rangeTokens > cfg.maxChunkTokens) {
      // Large symbol -- try to split at child boundaries
      chunks.push(
        ...splitLargeSymbol(range, symbols, lines, cfg, filePath, language),
      )
    } else {
      chunks.push({
        id: chunkId(filePath, [range.symbol], range.startLine, range.endLine),
        filePath,
        content: rangeContent,
        startLine: range.startLine,
        endLine: range.endLine,
        symbols: [range.symbol],
        language,
        estimatedTokens: rangeTokens,
      })
    }
  }

  // Add any trailing code after the last symbol
  const lastRange = topRanges[topRanges.length - 1]
  if (lastRange && lastRange.endLine < lines.length) {
    const trailingContent = extractLines(lines, lastRange.endLine + 1, lines.length)
    const trailingTokens = estimateTokens(trailingContent)
    if (trailingTokens > 0) {
      chunks.push({
        id: `${filePath}#trailing`,
        filePath,
        content: trailingContent,
        startLine: lastRange.endLine + 1,
        endLine: lines.length,
        symbols: [],
        language,
        estimatedTokens: trailingTokens,
      })
    }
  }

  // Merge small adjacent chunks
  chunks = mergeSmallChunks(chunks, cfg, filePath, language, lines)

  // Add overlap at boundaries
  chunks = addOverlap(chunks, lines, cfg.overlapLines, filePath)

  return chunks
}
