/**
 * Regex-based symbol extractor for TypeScript files.
 * Works without ts-morph — extracts classes, interfaces, functions,
 * types, enums, and const declarations from source text.
 */

export interface ExtractedSymbol {
  name: string
  kind: 'class' | 'interface' | 'function' | 'type' | 'enum' | 'const'
  signature: string
  exported: boolean
  line: number
  filePath: string
}

/**
 * Ordered patterns for symbol extraction.
 * Each pattern captures: optional export, keyword, name, and trailing signature context.
 */
const PATTERNS: Array<{
  kind: ExtractedSymbol['kind']
  regex: RegExp
}> = [
  {
    kind: 'class',
    regex:
      /^(export\s)?(?:abstract\s)?class\s+(\w+)/,
  },
  {
    kind: 'interface',
    regex: /^(export\s)?interface\s+(\w+)/,
  },
  {
    kind: 'enum',
    regex: /^(export\s)?(?:const\s)?enum\s+(\w+)/,
  },
  {
    kind: 'type',
    regex: /^(export\s)?type\s+(\w+)\s*[<=]/,
  },
  {
    kind: 'function',
    regex:
      /^(export\s)?(?:async\s)?function\s+(\w+)/,
  },
  {
    kind: 'const',
    regex:
      /^(export\s)?const\s+(\w+)/,
  },
]

/**
 * Extract symbols from TypeScript source code using regex patterns.
 * Not as accurate as AST but works without ts-morph dependency.
 */
export function extractSymbols(
  filePath: string,
  content: string,
): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimStart()

    // Skip comments and empty lines
    if (
      line.startsWith('//') ||
      line.startsWith('/*') ||
      line.startsWith('*') ||
      line === ''
    ) {
      continue
    }

    for (const { kind, regex } of PATTERNS) {
      const match = regex.exec(line)
      if (!match) continue

      const exported = match[1] != null
      const name = match[2]!
      // Use the full match as the signature, trimmed of trailing whitespace and braces
      const signature = match[0]
        .replace(/\s*\{?\s*$/, '')
        .replace(/^export\s+/, '')
        .trim()

      symbols.push({
        name,
        kind,
        signature,
        exported,
        line: i + 1,
        filePath,
      })

      // Only match the first pattern per line
      break
    }
  }

  return symbols
}
