/**
 * Helper used by loaders that accept a `projectDir` shorthand instead of a
 * fully resolved `DzupAgentPaths`. Produces a minimal paths record suitable
 * for standalone invocations (CLI / server routes) that do not run the full
 * WorkspaceResolver pipeline.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { DzupAgentPaths } from '../types.js'

/**
 * Derive a minimal `DzupAgentPaths` from a project directory.
 *
 * - `globalDir`   → `~/.dzupagent/`
 * - `workspaceDir`→ `undefined` (collapsed into project when unknown)
 * - `projectDir`  → `<projectDir>/.dzupagent/`
 * - `stateFile`   → `<projectDir>/.dzupagent/state.json`
 * - `projectConfig` → `<projectDir>/.dzupagent/config.json`
 */
export function derivePathsFromProjectDir(projectDir: string | undefined): DzupAgentPaths {
  if (!projectDir) {
    throw new Error(
      '[dzupagent] Loader requires either `paths` or `projectDir` in its options',
    )
  }
  const dzup = join(projectDir, '.dzupagent')
  return {
    globalDir: join(homedir(), '.dzupagent'),
    workspaceDir: undefined,
    projectDir: dzup,
    stateFile: join(dzup, 'state.json'),
    projectConfig: join(dzup, 'config.json'),
  }
}
