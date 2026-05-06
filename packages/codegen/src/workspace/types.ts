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
    allowLocalFallback?: boolean
    containerId?: string
    permissionTier?: 'read-only' | 'read-write' | 'full'
  }
  search?: {
    provider?: 'ripgrep' | 'grep' | 'builtin'
    maxResults?: number
  }
  command?: {
    timeoutMs?: number
    /**
     * Allowlist of executable names that may be invoked via `runCommand`.
     *
     * - `undefined` (default): falls back to the conservative
     *   `DEFAULT_ALLOWED_COMMANDS` list inside `LocalWorkspace`.
     * - `string[]`: explicit allowlist; any command not in the array is rejected.
     * - `'*'` (literal sentinel): disables the safety check entirely. Intended
     *   for tests only; production callers should always pass an explicit list.
     */
    allowedCommands?: string[] | '*'
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
 * Error thrown when `runCommand` is called with an executable that is not in
 * the configured (or default) allowlist. Easier to assert against in tests
 * than the previous string-matching approach.
 */
export class WorkspaceCommandDeniedError extends Error {
  constructor(
    public readonly command: string,
    public readonly allowedCommands: readonly string[],
  ) {
    super(
      `Workspace command rejected: '${command}' is not in the allowed commands list ` +
        `(${allowedCommands.length === 0 ? '<empty>' : allowedCommands.join(', ')}).`,
    )
    this.name = 'WorkspaceCommandDeniedError'
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
