/**
 * Workspace types — foundational interfaces for unified workspace abstraction.
 *
 * Used by LocalWorkspace, SandboxedWorkspace, and WorkspaceFactory.
 */

/** Result of a text search within workspace files. */
export interface SearchResult {
  filePath: string
  line: number
  column: number
  matchText: string
  context?: { before: string; after: string }
}

/** Result of running a command inside the workspace. */
export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Configuration options for creating a Workspace instance. */
export interface WorkspaceOptions {
  rootDir: string
  sandbox?: {
    enabled: boolean
    containerId?: string
    permissionTier?: 'read-only' | 'read-write' | 'full'
  }
  search?: {
    provider?: 'ripgrep' | 'grep' | 'builtin'
    maxResults?: number
  }
  command?: {
    timeoutMs?: number
    allowedCommands?: string[]
  }
}

/** Error thrown when a workspace path would escape its configured root. */
export class WorkspacePathSecurityError extends Error {
  constructor(
    public readonly attemptedPath: string,
    public readonly workspaceRoot: string,
  ) {
    super(
      `Workspace path rejected: paths must be relative and stay within workspace root "${workspaceRoot}".`,
    )
    this.name = 'WorkspacePathSecurityError'
  }
}

/**
 * @experimental
 * Unified abstraction over file system operations and command execution.
 * File paths, globs, and command working directories are relative to rootDir.
 * Absolute paths and traversal outside rootDir are rejected.
 */
export interface Workspace {
  readonly rootDir: string
  readonly options: WorkspaceOptions

  /** Read the contents of a file as UTF-8 text. */
  readFile(path: string): Promise<string>

  /** Write content to a file, creating intermediate directories as needed. */
  writeFile(path: string, content: string): Promise<void>

  /** List files matching a glob pattern, relative to rootDir. */
  listFiles(glob: string): Promise<string[]>

  /** Search file contents for a query string or pattern. */
  search(
    query: string,
    options?: { glob?: string; maxResults?: number },
  ): Promise<SearchResult[]>

  /** Run a command with arguments inside the workspace. */
  runCommand(
    cmd: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<CommandResult>

  /** Check whether a file or directory exists at the given path. */
  exists(path: string): Promise<boolean>
}
