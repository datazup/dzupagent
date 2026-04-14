/**
 * Discovers and loads AGENTS.md files from a project directory tree.
 *
 * Walks the directory up to a configurable depth, skipping common
 * non-project directories (node_modules, .git, dist, etc.) and
 * honouring .gitignore when present.
 */

import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseAgentsMd, type AgentsMdSection } from './agents-md-parser.js'

/** Result of loading a single AGENTS.md file. */
export interface LoadedAgentsFile {
  /** Absolute path to the file */
  path: string
  /** Parsed sections from the file */
  sections: AgentsMdSection[]
}

/** Options for the AGENTS.md loader. */
export interface LoadAgentsOptions {
  /** Maximum directory depth to search (default: 5) */
  maxDepth?: number
  /** File names to look for (default: ['AGENTS.md']) */
  fileNames?: string[]
}

/** Default directories that are always skipped. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.cache',
  '__pycache__',
  '.venv',
  'vendor',
])

/**
 * Discover and load all AGENTS.md files under `projectDir`.
 *
 * Returns an array of `{ path, sections }` for each file found, sorted
 * by path depth (shallowest first so that root-level files take priority).
 */
export async function loadAgentsFiles(
  projectDir: string,
  options?: LoadAgentsOptions,
): Promise<LoadedAgentsFile[]> {
  const maxDepth = options?.maxDepth ?? 5
  const fileNames = new Set(
    (options?.fileNames ?? ['AGENTS.md']).map(f => f.toLowerCase()),
  )

  const gitignorePatterns = await loadGitignorePatterns(projectDir)
  const results: LoadedAgentsFile[] = []

  await walk(resolve(projectDir), 0, maxDepth, fileNames, gitignorePatterns, results, resolve(projectDir))

  // Sort by depth (shallowest first)
  results.sort((a, b) => {
    const depthA = a.path.split('/').length
    const depthB = b.path.split('/').length
    return depthA - depthB
  })

  return results
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  fileNames: Set<string>,
  gitignorePatterns: string[],
  results: LoadedAgentsFile[],
  rootDir: string,
): Promise<void> {
  if (depth > maxDepth) return

  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // Permission denied or other access error
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      if (isGitignored(fullPath, rootDir, gitignorePatterns)) continue
      await walk(fullPath, depth + 1, maxDepth, fileNames, gitignorePatterns, results, rootDir)
    } else if (entry.isFile() && fileNames.has(entry.name.toLowerCase())) {
      try {
        const content = await readFile(fullPath, 'utf-8')
        const sections = parseAgentsMd(content)
        if (sections.length > 0) {
          results.push({ path: fullPath, sections })
        }
      } catch {
        // Unreadable file — skip silently
      }
    }
  }
}

/**
 * Load simple .gitignore patterns from the project root.
 *
 * Only supports basic directory patterns (e.g., `build/`, `tmp`).
 * Glob patterns with wildcards are ignored for simplicity.
 */
async function loadGitignorePatterns(projectDir: string): Promise<string[]> {
  try {
    const content = await readFile(join(projectDir, '.gitignore'), 'utf-8')
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .filter(line => !line.includes('*')) // Only simple dir/file patterns
      .map(line => line.replace(/\/$/, '')) // Strip trailing slash
  } catch {
    return []
  }
}

/** Check if a path matches a simple gitignore pattern. */
function isGitignored(
  fullPath: string,
  rootDir: string,
  patterns: string[],
): boolean {
  const relative = fullPath.slice(rootDir.length + 1)
  const segments = relative.split('/')

  for (const pattern of patterns) {
    // Match if any path segment equals the pattern
    if (segments.includes(pattern)) return true
  }

  return false
}
