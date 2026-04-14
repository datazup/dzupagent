/**
 * Build a file dependency graph from import statements.
 * Parses import declarations via regex and resolves relative paths.
 */

import * as path from 'node:path'

export interface ImportEdge {
  from: string
  to: string
  symbols: string[]
}

export interface ImportGraph {
  edges: ImportEdge[]
  /** Files that import the given file */
  importedBy(filePath: string): string[]
  /** Files imported by the given file */
  importsFrom(filePath: string): string[]
  /** Files with no imports (entry points / roots) */
  roots(): string[]
}

/**
 * Regex patterns for import statement forms:
 *   import { A, B } from './path'
 *   import type { A } from './path'
 *   import A from './path'
 *   import * as A from './path'
 */
const IMPORT_RE =
  /import\s+(?:type\s)?(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]([^'"]+)['"]/g

/**
 * Resolve an import specifier to an absolute file path.
 * Only resolves relative imports (starting with . or ..).
 * Returns null for bare / package imports.
 */
function resolveImport(
  importerPath: string,
  specifier: string,
  knownPaths: Set<string>,
): string | null {
  if (!specifier.startsWith('.')) return null

  const importerDir = path.dirname(importerPath)
  let resolved = path.resolve(importerDir, specifier)

  // Strip .js / .mjs extension that might be used in ESM source
  resolved = resolved.replace(/\.(js|mjs)$/, '.ts')

  // If the resolved path is already known, return it
  if (knownPaths.has(resolved)) return resolved

  // Try adding .ts extension
  const withTs = resolved + '.ts'
  if (knownPaths.has(withTs)) return withTs

  // Try index.ts in a directory
  const indexTs = path.join(resolved, 'index.ts')
  if (knownPaths.has(indexTs)) return indexTs

  return null
}

/**
 * Build an import graph from a set of files.
 * Resolves relative imports to absolute paths within the given file set.
 */
export function buildImportGraph(
  files: Array<{ path: string; content: string }>,
  rootDir: string,
): ImportGraph {
  const knownPaths = new Set(
    files.map((f) => path.resolve(rootDir, f.path)),
  )
  const edges: ImportEdge[] = []

  for (const file of files) {
    const absFrom = path.resolve(rootDir, file.path)
    // Reset regex state for each file
    IMPORT_RE.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = IMPORT_RE.exec(file.content)) !== null) {
      const namedGroup = match[1] // { A, B }
      const namespaceGroup = match[2] // * as A
      const defaultGroup = match[3] // A (default)
      const specifier = match[4]!

      const symbols: string[] = []
      if (namedGroup) {
        for (const s of namedGroup.split(',')) {
          const trimmed = s.trim()
          if (trimmed) symbols.push(trimmed)
        }
      } else if (namespaceGroup) {
        symbols.push(`* as ${namespaceGroup}`)
      } else if (defaultGroup) {
        symbols.push(defaultGroup)
      }

      const resolved = resolveImport(absFrom, specifier, knownPaths)
      if (resolved) {
        edges.push({ from: absFrom, to: resolved, symbols })
      }
    }
  }

  // Pre-compute lookup maps
  const byImporter = new Map<string, string[]>()
  const byImported = new Map<string, string[]>()
  const filesWithImports = new Set<string>()

  for (const edge of edges) {
    filesWithImports.add(edge.from)

    const fromList = byImporter.get(edge.from) ?? []
    fromList.push(edge.to)
    byImporter.set(edge.from, fromList)

    const toList = byImported.get(edge.to) ?? []
    toList.push(edge.from)
    byImported.set(edge.to, toList)
  }

  return {
    edges,
    importedBy(filePath: string): string[] {
      return byImported.get(path.resolve(rootDir, filePath)) ?? []
    },
    importsFrom(filePath: string): string[] {
      return byImporter.get(path.resolve(rootDir, filePath)) ?? []
    },
    roots(): string[] {
      return [...knownPaths].filter((p) => !filesWithImports.has(p))
    },
  }
}
