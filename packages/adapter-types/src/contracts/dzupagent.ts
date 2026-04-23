/** Strategy for injecting project memory into Codex runs */
export type CodexMemoryStrategy =
  | 'inject-always'
  | 'inject-on-new-thread'
  | 'trust-thread-history'

/** Global/project DzupAgent configuration (config.json) */
export interface DzupAgentConfig {
  codex?: {
    /** How to handle memory injection for Codex. Default: 'inject-on-new-thread' */
    memoryStrategy?: CodexMemoryStrategy | undefined
  }
  memory?: {
    /** Max tokens to inject per run. Default: 2000 */
    maxTokens?: number | undefined
    /** Include global (~/.dzupagent/memory/) entries. Default: true */
    includeGlobal?: boolean | undefined
    /** Include workspace-level entries. Default: true */
    includeWorkspace?: boolean | undefined
  }
  sync?: {
    /** Auto-sync to native files on project open. Default: false */
    onProjectOpen?: boolean | undefined
  }
}

/** Resolved filesystem paths for a project's .dzupagent/ context */
export interface DzupAgentPaths {
  /** ~/.dzupagent/ */
  globalDir: string
  /** <git-root>/.dzupagent/ — workspace level, undefined if same as project */
  workspaceDir: string | undefined
  /** <project>/.dzupagent/ */
  projectDir: string
  /** <project>/.dzupagent/state.json */
  stateFile: string
  /** <project>/.dzupagent/config.json */
  projectConfig: string
}
