/**
 * Multi-file import coherence validator.
 *
 * Validates that all relative imports across a set of generated files resolve
 * correctly, detects self-imports and circular import chains.
 * Pure function — no VFS dependency, works on plain file maps.
 */

export interface ImportIssue {
  file: string
  line: number
  importPath: string
  issue: 'unresolved' | 'circular' | 'self-import'
}

export interface ImportValidationResult {
  valid: boolean
  issues: ImportIssue[]
}

const IMPORT_RE = /(?:import|export)\s+.*?from\s+['"](\.[^'"]+)['"]/g
const DYNAMIC_RE = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue']

/**
 * Validate imports across a set of files.
 * Checks that all relative imports resolve to files in the provided set.
 * Detects circular import chains and self-imports.
 */
export function validateImports(
  files: Map<string, string> | Record<string, string>,
  rootDir = '',
): ImportValidationResult {
  const fileMap = files instanceof Map ? files : new Map(Object.entries(files))
  const knownPaths = new Set(fileMap.keys())
  const issues: ImportIssue[] = []

  // Build adjacency list for cycle detection
  const adjacency = new Map<string, string[]>()

  for (const [filePath, content] of fileMap) {
    const lines = content.split('\n')
    const edges: string[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      for (const regex of [IMPORT_RE, DYNAMIC_RE]) {
        regex.lastIndex = 0
        let match: RegExpExecArray | null
        // We need to match against individual lines for line numbers
        const lineRegex = new RegExp(regex.source, regex.flags)
        while ((match = lineRegex.exec(line)) !== null) {
          const importPath = match[1]!
          const resolved = resolveImport(filePath, importPath, rootDir)

          // Self-import check
          if (resolved === filePath || resolveWithExtensions(resolved, knownPaths) === filePath) {
            issues.push({ file: filePath, line: i + 1, importPath, issue: 'self-import' })
            continue
          }

          const resolvedFull = resolveWithExtensions(resolved, knownPaths)
          if (resolvedFull === null) {
            issues.push({ file: filePath, line: i + 1, importPath, issue: 'unresolved' })
          } else {
            edges.push(resolvedFull)
          }
        }
      }
    }

    adjacency.set(filePath, edges)
  }

  // DFS cycle detection
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      // Found a cycle — report on the edge that closes it
      const cycleStart = path.indexOf(node)
      const cycle = path.slice(cycleStart)
      const lastFile = cycle[cycle.length - 1]!
      issues.push({
        file: lastFile,
        line: 0,
        importPath: node,
        issue: 'circular',
      })
      return
    }
    if (visited.has(node)) return

    inStack.add(node)
    path.push(node)

    for (const neighbor of adjacency.get(node) ?? []) {
      dfs(neighbor, path)
    }

    path.pop()
    inStack.delete(node)
    visited.add(node)
  }

  for (const node of adjacency.keys()) {
    if (!visited.has(node)) {
      dfs(node, [])
    }
  }

  return { valid: issues.length === 0, issues }
}

/** Resolve a relative import path against the importing file's directory. */
function resolveImport(fromFile: string, importPath: string, rootDir: string): string {
  const fromDir = fromFile.includes('/')
    ? fromFile.slice(0, fromFile.lastIndexOf('/'))
    : rootDir || '.'

  const parts = `${fromDir}/${importPath}`.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') { resolved.pop(); continue }
    resolved.push(part)
  }
  return resolved.join('/')
}

/** Try to resolve a path against known paths, with extension and index fallbacks. */
function resolveWithExtensions(path: string, knownPaths: Set<string>): string | null {
  if (knownPaths.has(path)) return path

  // Try adding extensions
  for (const ext of EXTENSIONS) {
    if (knownPaths.has(path + ext)) return path + ext
  }

  // ESM .js -> .ts mapping
  if (path.endsWith('.js')) {
    const base = path.slice(0, -3)
    if (knownPaths.has(base + '.ts')) return base + '.ts'
    if (knownPaths.has(base + '.tsx')) return base + '.tsx'
  }

  // Directory index
  for (const ext of EXTENSIONS) {
    const indexPath = `${path}/index${ext}`
    if (knownPaths.has(indexPath)) return indexPath
  }

  return null
}
