/**
 * CodegenToolContext — optional context that tools can use for
 * workspace-backed file operations.
 *
 * When `workspace` is provided, tools route file reads/writes through
 * the Workspace abstraction (which may be local or sandboxed).
 * When absent, tools fall back to their existing behaviour (VFS or
 * state-message based).
 */
import type { Workspace } from '../workspace/types.js'
import type { VirtualFS } from '../vfs/virtual-fs.js'

export interface CodegenToolContext {
  /** VirtualFS instance (legacy — tools already use this). */
  vfs?: VirtualFS
  /** Workspace abstraction — preferred when available. */
  workspace?: Workspace
}
