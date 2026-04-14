/**
 * Hierarchical AGENTS.md / CLAUDE.md discovery.
 *
 * Walks from global config → project root → subdirectories → CWD,
 * collecting agent configuration files at each level.
 *
 * Discovery order (later overrides earlier):
 * 1. Global: ~/.config/dzupagent/AGENTS.md
 * 2. Project root: git root/AGENTS.md, CLAUDE.md
 * 3. Subdirectories: walk from git root to CWD
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { parseAgentsMd, type AgentsMdConfig } from './agents-md-parser.js'

export interface HierarchyLevel {
  path: string
  source: 'global' | 'project' | 'directory'
  config: AgentsMdConfig
}

/** File names to search for (in priority order) */
const CONFIG_FILENAMES = ['AGENTS.md', '.agents.md', 'CLAUDE.md']

/**
 * Discover agent configuration files from global → project → CWD.
 * Returns levels in discovery order (global first, most-specific last).
 */
export function discoverAgentConfigs(cwd: string): HierarchyLevel[] {
  const levels: HierarchyLevel[] = []

  // 1. Global config
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''
  if (home) {
    const globalDir = join(home, '.config', 'dzupagent')
    for (const name of CONFIG_FILENAMES) {
      const filePath = join(globalDir, name)
      const config = tryReadConfig(filePath)
      if (config) {
        levels.push({ path: filePath, source: 'global', config })
      }
    }
  }

  // 2. Project root (git root)
  const gitRoot = getGitRoot(cwd)
  if (gitRoot) {
    for (const name of CONFIG_FILENAMES) {
      const filePath = join(gitRoot, name)
      const config = tryReadConfig(filePath)
      if (config) {
        levels.push({ path: filePath, source: 'project', config })
      }
    }

    // 3. Walk from git root to CWD (exclude root itself, already handled)
    if (cwd !== gitRoot) {
      const dirs = getDirectoriesBetween(gitRoot, cwd)
      for (const dir of dirs) {
        for (const name of CONFIG_FILENAMES) {
          const filePath = join(dir, name)
          const config = tryReadConfig(filePath)
          if (config) {
            levels.push({ path: filePath, source: 'directory', config })
          }
        }
      }
    }
  }

  return levels
}

/**
 * Try to read and parse a config file. Returns null if file doesn't exist.
 */
function tryReadConfig(filePath: string): AgentsMdConfig | null {
  if (!existsSync(filePath)) return null
  try {
    const content = readFileSync(filePath, 'utf8')
    return parseAgentsMd(content)
  } catch {
    return null
  }
}

/**
 * Get the git root directory, or null if not in a git repo.
 */
function getGitRoot(cwd: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * Get all directories between two paths (exclusive of `from`, inclusive of `to`).
 * Returns them from deepest to shallowest (most-specific first).
 */
function getDirectoriesBetween(from: string, to: string): string[] {
  const dirs: string[] = []
  let current = to
  while (current !== from && current !== dirname(current)) {
    dirs.push(current)
    current = dirname(current)
  }
  return dirs.reverse() // shallowest first
}
