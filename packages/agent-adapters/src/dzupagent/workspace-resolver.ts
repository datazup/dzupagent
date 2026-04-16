/**
 * WorkspaceResolver — resolves DzupAgentPaths for a project root.
 *
 * Walks the filesystem upward to find the git root (workspace boundary),
 * then assembles absolute paths for all .dzupagent/ locations.
 */

import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DzupAgentPaths } from '../types.js'

/**
 * Walk up from startDir until a .git directory is found.
 * Returns the directory containing .git, or undefined if not in a git repo.
 */
async function findGitRoot(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir)
  // Guard against infinite loops on unusual filesystems
  for (let depth = 0; depth < 64; depth++) {
    try {
      await access(join(dir, '.git'), constants.F_OK)
      return dir
    } catch {
      const parent = resolve(dir, '..')
      if (parent === dir) return undefined // reached fs root
      dir = parent
    }
  }
  return undefined
}

export class WorkspaceResolver {
  /**
   * Resolve all .dzupagent paths for the given project root.
   *
   * - globalDir:    ~/.dzupagent/
   * - workspaceDir: <git-root>/.dzupagent/ (only set when git root ≠ project root)
   * - projectDir:   <projectRoot>/.dzupagent/
   */
  async resolve(projectRoot: string): Promise<DzupAgentPaths> {
    const absRoot = resolve(projectRoot)
    const globalDir = join(homedir(), '.dzupagent')

    const gitRoot = await findGitRoot(absRoot)
    // workspaceDir is the git-root-level .dzupagent when it differs from project root
    const workspaceDir =
      gitRoot !== undefined && gitRoot !== absRoot
        ? join(gitRoot, '.dzupagent')
        : undefined

    const projectDir = join(absRoot, '.dzupagent')

    return {
      globalDir,
      workspaceDir,
      projectDir,
      stateFile: join(projectDir, 'state.json'),
      projectConfig: join(projectDir, 'config.json'),
    }
  }
}
