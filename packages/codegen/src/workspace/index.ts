export type {
  SearchResult,
  CommandResult,
  WorkspaceOptions,
  Workspace,
} from './types.js'
export { WorkspacePathSecurityError, WorkspaceCommandDeniedError } from './types.js'

export { LocalWorkspace, DEFAULT_ALLOWED_COMMANDS } from './local-workspace.js'
export { SandboxedWorkspace } from './sandboxed-workspace.js'
export { WorkspaceConfigurationError, WorkspaceFactory } from './workspace-factory.js'
