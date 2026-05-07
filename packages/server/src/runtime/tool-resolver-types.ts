import type { StructuredToolInterface } from '@langchain/core/tools'
import type { ToolProfile } from './tool-profile-config.js'
import type {
  ConnectorTokenProfile,
  GitWorkspaceProfile,
  HttpConnectorProfile,
} from './tool-profile-selection.js'

// ---------------------------------------------------------------------------
// Context & Result types
//
// These types live in a leaf module so that helpers used by `tool-resolver.ts`
// (for example `custom-tool-instantiation.ts`) can import the type surface
// without creating a circular dependency back through `tool-resolver.ts`.
// ---------------------------------------------------------------------------

export interface ToolResolverContext {
  toolNames?: string[]
  toolProfile?: ToolProfile
  metadata?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
  /** Server-owned HTTP connector profiles keyed by profile name. */
  httpConnectorProfiles?: Record<string, HttpConnectorProfile>
  /** Default server-owned HTTP connector profile. Defaults to "default". */
  defaultHttpConnectorProfile?: string
  /** Server-owned GitHub connector token profiles keyed by profile name. */
  githubConnectorProfiles?: Record<string, ConnectorTokenProfile>
  /** Default GitHub connector profile. Defaults to "default". */
  defaultGithubConnectorProfile?: string
  /** Server-owned Slack connector token profiles keyed by profile name. */
  slackConnectorProfiles?: Record<string, ConnectorTokenProfile>
  /** Default Slack connector profile. Defaults to "default". */
  defaultSlackConnectorProfile?: string
  /** Server-owned Git workspace profiles keyed by profile name. */
  gitWorkspaceProfiles?: Record<string, GitWorkspaceProfile>
  /** Default server-owned Git workspace profile. Defaults to "default". */
  defaultGitWorkspaceProfile?: string
  /**
   * Unsafe compatibility escape hatch for legacy callers that passed
   * metadata.httpBaseUrl/httpHeaders. Keep false for untrusted runs.
   */
  allowUnsafeMetadataHttpConnector?: boolean
  /**
   * Unsafe compatibility escape hatch for legacy callers that passed metadata.cwd.
   * The selected cwd is still required to stay inside the selected workspace root.
   */
  allowUnsafeMetadataGitCwd?: boolean
}

export type ToolSource = 'git' | 'connector' | 'mcp' | 'custom'

export interface ToolResolverResult {
  tools: StructuredToolInterface[]
  activated: Array<{ name: string; source: ToolSource }>
  unresolved: string[]
  warnings: string[]
  /** Call to disconnect MCP servers after the run completes. */
  cleanup?: () => Promise<void>
}

export type CustomToolResolver = (
  context: ToolResolverContext,
) => Promise<StructuredToolInterface[]>

export interface ToolResolverOptions {
  /** 'strict' throws if any tools remain unresolved; 'lenient' warns (default). */
  resolvePolicy?: 'strict' | 'lenient'
}
