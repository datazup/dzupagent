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
import type { PermissionTier } from '../sandbox/permission-tiers.js'

export interface CodegenToolContext {
  /** VirtualFS instance (legacy — tools already use this). */
  vfs?: VirtualFS
  /** Workspace abstraction — preferred when available. */
  workspace?: Workspace
  /**
   * REC-M-06 — active sandbox permission tier governing this tool. When
   * provided, write-capable tool factories use this to fail fast at
   * issuance time (via `assertTierAllowsWrite`) so a `read-only` tier
   * rejects the tool synchronously instead of letting the model invoke
   * it and only failing when the sandbox attempts the write.
   */
  permissionTier?: PermissionTier
}
