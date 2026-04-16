/**
 * SandboxedWorkspace — wraps a LocalWorkspace, routing writes and command
 * execution through a SandboxProtocol while delegating reads locally.
 */
import type { Workspace, WorkspaceOptions, SearchResult, CommandResult } from './types.js'
import type { LocalWorkspace } from './local-workspace.js'
import type { SandboxProtocol } from '../sandbox/sandbox-protocol.js'

export class SandboxedWorkspace implements Workspace {
  readonly rootDir: string
  readonly options: WorkspaceOptions

  constructor(
    private readonly inner: LocalWorkspace,
    private readonly sandbox: SandboxProtocol,
  ) {
    this.rootDir = inner.rootDir
    this.options = inner.options
  }

  // --- Reads: delegate to local workspace -----------------------------------

  readFile(path: string): Promise<string> {
    return this.inner.readFile(path)
  }

  listFiles(glob: string): Promise<string[]> {
    return this.inner.listFiles(glob)
  }

  search(
    query: string,
    options?: { glob?: string; maxResults?: number },
  ): Promise<SearchResult[]> {
    return this.inner.search(query, options)
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path)
  }

  // --- Writes: route through sandbox ----------------------------------------

  async writeFile(path: string, content: string): Promise<void> {
    await this.sandbox.uploadFiles({ [path]: content })
  }

  // --- Command execution: route through sandbox -----------------------------

  async runCommand(
    cmd: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<CommandResult> {
    const allowedCommands = this.options.command?.allowedCommands
    if (allowedCommands && !allowedCommands.includes(cmd)) {
      return {
        exitCode: 126,
        stdout: '',
        stderr: `Command '${cmd}' is not in the allowed commands list.`,
        timedOut: false,
      }
    }

    // Build a shell command string from cmd + args
    const shellCmd = [cmd, ...args].map(escapeShellArg).join(' ')

    const result = await this.sandbox.execute(shellCmd, {
      cwd: options?.cwd,
      timeoutMs: options?.timeoutMs ?? this.options.command?.timeoutMs,
    })

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    }
  }
}

/** Minimal shell argument escaping for sandbox command strings. */
function escapeShellArg(arg: string): string {
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, "'\\''")}'`
}
