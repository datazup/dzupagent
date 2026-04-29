/**
 * WorkspaceFactory — creates the appropriate Workspace implementation
 * based on the provided options and optional sandbox instance.
 */
import type { WorkspaceOptions, Workspace } from './types.js'
import type { SandboxProtocol } from '../sandbox/sandbox-protocol.js'
import { LocalWorkspace } from './local-workspace.js'
import { SandboxedWorkspace } from './sandboxed-workspace.js'

export class WorkspaceConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceConfigurationError'
  }
}

export class WorkspaceFactory {
  /**
   * Create a Workspace instance.
   *
   * If `options.sandbox?.enabled` is true, a sandbox backend must be provided.
   * Callers that intentionally accept local execution can opt in with
   * `options.sandbox.allowLocalFallback`.
   */
  static create(options: WorkspaceOptions, sandbox?: SandboxProtocol): Workspace {
    const local = new LocalWorkspace(options)

    if (!options.sandbox?.enabled) {
      return local
    }

    if (sandbox) {
      return new SandboxedWorkspace(local, sandbox)
    }

    if (options.sandbox.allowLocalFallback) {
      return local
    }

    throw new WorkspaceConfigurationError(
      'Sandbox-enabled codegen requires a sandbox backend. Provide a SandboxProtocol instance or set sandbox.allowLocalFallback=true to opt in to local execution.',
    )
  }
}
