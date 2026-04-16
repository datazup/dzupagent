/**
 * WorkspaceFactory — creates the appropriate Workspace implementation
 * based on the provided options and optional sandbox instance.
 */
import type { WorkspaceOptions, Workspace } from './types.js'
import type { SandboxProtocol } from '../sandbox/sandbox-protocol.js'
import { LocalWorkspace } from './local-workspace.js'
import { SandboxedWorkspace } from './sandboxed-workspace.js'

export class WorkspaceFactory {
  /**
   * Create a Workspace instance.
   *
   * If `options.sandbox?.enabled` is true AND a `sandbox` instance is provided,
   * returns a SandboxedWorkspace that wraps a LocalWorkspace.
   * Otherwise returns a plain LocalWorkspace.
   */
  static create(options: WorkspaceOptions, sandbox?: SandboxProtocol): Workspace {
    const local = new LocalWorkspace(options)

    if (options.sandbox?.enabled && sandbox) {
      return new SandboxedWorkspace(local, sandbox)
    }

    return local
  }
}
