/**
 * Import validator — checks that all relative imports in generated code resolve
 * to existing files in the VirtualFS.
 *
 * Catches broken cross-file references before code is written to disk.
 */
import type { VirtualFS } from '../vfs/virtual-fs.js'

export interface ImportValidationResult {
  valid: boolean
  errors: ImportError[]
}

export interface ImportError {
  file: string
  importPath: string
  resolved: string
  message: string
}

/**
 * Validate that all relative imports in TypeScript/JavaScript files resolve
 * to files that exist in the VFS.
 */
export function validateImports(vfs: VirtualFS): ImportValidationResult {
  const errors: ImportError[] = []

  for (const filePath of vfs.list()) {
    if (!isJsOrTs(filePath)) continue

    const content = vfs.read(filePath)
    if (!content) continue

    const imports = extractRelativeImports(content)
    for (const importPath of imports) {
      const resolved = resolveImport(filePath, importPath)
      if (!fileExists(vfs, resolved)) {
        errors.push({
          file: filePath,
          importPath,
          resolved,
          message: `Unresolved import "${importPath}" in ${filePath} → ${resolved}`,
        })
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/** Extract relative import paths from source code */
function extractRelativeImports(content: string): string[] {
  const imports: string[] = []
  // Match: import ... from './path' or import ... from '../path'
  const regex = /(?:import|export)\s+.*?from\s+['"](\.[^'"]+)['"]/g
  let match
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) imports.push(match[1])
  }
  // Match: import('./path') — dynamic imports
  const dynamicRegex = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g
  while ((match = dynamicRegex.exec(content)) !== null) {
    if (match[1]) imports.push(match[1])
  }
  return imports
}

/** Resolve a relative import path against the importing file */
function resolveImport(fromFile: string, importPath: string): string {
  const fromDir = fromFile.includes('/')
    ? fromFile.slice(0, fromFile.lastIndexOf('/'))
    : '.'

  // Normalize: join fromDir + importPath
  const parts = `${fromDir}/${importPath}`.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') { resolved.pop(); continue }
    resolved.push(part)
  }
  return resolved.join('/')
}

/** Check if a file exists in the VFS, trying common extensions and .js→.ts mapping */
function fileExists(vfs: VirtualFS, path: string): boolean {
  // Try exact path
  if (vfs.exists(path)) return true
  // Try with extensions (no-extension imports)
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.vue']) {
    if (vfs.exists(path + ext)) return true
  }
  // ESM .js → .ts mapping (TypeScript compiles .ts to .js imports)
  if (path.endsWith('.js')) {
    const tsPath = path.slice(0, -3) + '.ts'
    if (vfs.exists(tsPath)) return true
    const tsxPath = path.slice(0, -3) + '.tsx'
    if (vfs.exists(tsxPath)) return true
  }
  // Try as directory with index
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    if (vfs.exists(`${path}/index${ext}`)) return true
  }
  return false
}

function isJsOrTs(path: string): boolean {
  return /\.(ts|tsx|js|jsx|vue)$/.test(path)
}
