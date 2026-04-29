import type { StructuredToolInterface } from '@langchain/core/tools'
import { validateMcpHttpEndpoint } from '../security/mcp-url-policy.js'
import { applyCustomToolResolver } from './custom-tool-instantiation.js'
import { resolveMcpTools } from './mcp-tool-instantiation.js'
import { resolveConnectorFactory, resolveGitFactory } from './tool-factories.js'
import {
  applyToolProfile,
  getToolProfileConfig,
  type ToolProfile,
  type ToolProfileConfig,
} from './tool-profile-config.js'
import {
  resolveTokenProfile,
  selectGitWorkspace,
  selectHttpConnectorProfile,
  type ConnectorTokenProfile,
  type GitWorkspaceProfile,
  type HttpConnectorProfile,
} from './tool-profile-selection.js'
import { hasCategory, pickEnabled } from './tool-selection.js'

export { getToolProfileConfig }
export type {
  ConnectorTokenProfile,
  GitWorkspaceProfile,
  HttpConnectorProfile,
  ToolProfile,
  ToolProfileConfig,
}

// ---------------------------------------------------------------------------
// Context & Result types
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

const GIT_TOOL_NAMES = new Set([
  'git_status',
  'git_diff',
  'git_commit',
  'git_log',
  'git_branch',
])

const GITHUB_TOOL_NAMES = new Set([
  'github_get_file',
  'github_list_issues',
  'github_create_issue',
  'github_create_pr',
  'github_search_code',
])

const SLACK_TOOL_NAMES = new Set([
  'slack_send_message',
  'slack_list_channels',
  'slack_search_messages',
])

const HTTP_TOOL_NAMES = new Set(['http_request'])

export interface ToolResolverOptions {
  /** 'strict' throws if any tools remain unresolved; 'lenient' warns (default). */
  resolvePolicy?: 'strict' | 'lenient'
}

export class ToolResolutionError extends Error {
  constructor(
    public readonly unresolved: string[],
    public readonly warnings: string[],
  ) {
    super(
      `Strict resolve policy: ${unresolved.length} tool(s) unresolved: ${unresolved.join(', ')}` +
      (warnings.length > 0 ? `. Warnings: ${warnings.join('; ')}` : ''),
    )
    this.name = 'ToolResolutionError'
  }
}

export async function resolveAgentTools(
  context: ToolResolverContext,
  customResolver?: CustomToolResolver,
  options?: ToolResolverOptions,
): Promise<ToolResolverResult> {
  const explicitNames = (context.toolNames ?? []).map((name) => name.trim()).filter(Boolean)
  const requested = new Set(explicitNames)
  applyToolProfile(requested, context.toolProfile)

  const unresolved = new Set(requested)
  const warnings: string[] = []
  const tools: StructuredToolInterface[] = []
  const activated: Array<{ name: string; source: ToolSource }> = []

  if (requested.size === 0 && !customResolver) {
    return { tools, activated, unresolved: [], warnings }
  }

  const wantGit = hasCategory(requested, 'git') || [...requested].some((name) => GIT_TOOL_NAMES.has(name))
  if (wantGit) {
    const { createGitTools, GitExecutor } = await resolveGitFactory()
    if (createGitTools && GitExecutor) {
      const gitWorkspace = selectGitWorkspace(context)
      warnings.push(...gitWorkspace.warnings)

      if (gitWorkspace.cwd && gitWorkspace.allowedRoots) {
        try {
          const gitExec = new GitExecutor({
            cwd: gitWorkspace.cwd,
            allowedRoots: gitWorkspace.allowedRoots,
          })
          const gitTools = createGitTools(gitExec, {
            allowMutatingTools: gitWorkspace.allowMutatingTools,
          })
          const enabledGit = pickEnabled(requested, GIT_TOOL_NAMES, 'git')
          for (const t of gitTools) {
            if (enabledGit.length === 0 || enabledGit.includes(t.name)) {
              tools.push(t)
              activated.push({ name: t.name, source: 'git' })
              unresolved.delete(t.name)
            }
          }
          unresolved.delete('git')
          unresolved.delete('git:*')
          unresolved.delete('connector:git')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          warnings.push(`Git tools requested but workspace policy rejected the cwd: ${message}`)
        }
      }
    } else {
      warnings.push('Git tools requested but @dzupagent/codegen is not available at runtime.')
    }
  }

  const wantConnectors = [...requested].some((n) =>
    GITHUB_TOOL_NAMES.has(n) || SLACK_TOOL_NAMES.has(n) || HTTP_TOOL_NAMES.has(n)
      || hasCategory(requested, 'github')
      || hasCategory(requested, 'slack')
      || hasCategory(requested, 'http'),
  )

  const connectors = wantConnectors ? await resolveConnectorFactory() : null
  if (wantConnectors && !connectors) {
    warnings.push('Connector tools requested but @dzupagent/connectors is not available at runtime.')
  }

  const enabledGithub = pickEnabled(requested, GITHUB_TOOL_NAMES, 'github')
  if (enabledGithub.length > 0 && connectors) {
    if (typeof context.metadata?.['githubToken'] === 'string') {
      warnings.push('Ignoring metadata.githubToken for GitHub connector; configure githubConnectorProfiles or GITHUB_TOKEN.')
    }
    const { token, warnings: profileWarnings } = resolveTokenProfile(
      'GitHub',
      context.githubConnectorProfiles,
      context.metadata?.['githubProfile'],
      context.defaultGithubConnectorProfile,
      context.env,
      'GITHUB_TOKEN',
    )
    warnings.push(...profileWarnings)

    if (!token) {
      warnings.push('GitHub tools requested but no server-side token profile or GITHUB_TOKEN is configured.')
    } else if (typeof connectors['createGitHubConnector'] === 'function') {
      const ghTools = (connectors['createGitHubConnector'] as (
        cfg: { token: string; enabledTools?: string[] },
      ) => StructuredToolInterface[])({ token, enabledTools: enabledGithub })
      for (const t of ghTools) {
        if (enabledGithub.includes(t.name)) {
          tools.push(t)
          activated.push({ name: t.name, source: 'connector' })
          unresolved.delete(t.name)
        }
      }
      unresolved.delete('github')
      unresolved.delete('github:*')
      unresolved.delete('connector:github')
    }
  }

  const enabledSlack = pickEnabled(requested, SLACK_TOOL_NAMES, 'slack')
  if (enabledSlack.length > 0 && connectors) {
    if (typeof context.metadata?.['slackToken'] === 'string') {
      warnings.push('Ignoring metadata.slackToken for Slack connector; configure slackConnectorProfiles or SLACK_BOT_TOKEN.')
    }
    const { token, warnings: profileWarnings } = resolveTokenProfile(
      'Slack',
      context.slackConnectorProfiles,
      context.metadata?.['slackProfile'],
      context.defaultSlackConnectorProfile,
      context.env,
      'SLACK_BOT_TOKEN',
    )
    warnings.push(...profileWarnings)

    if (!token) {
      warnings.push('Slack tools requested but no server-side token profile or SLACK_BOT_TOKEN is configured.')
    } else if (typeof connectors['createSlackConnector'] === 'function') {
      const slackTools = (connectors['createSlackConnector'] as (
        cfg: { token: string; enabledTools?: string[] },
      ) => StructuredToolInterface[])({ token, enabledTools: enabledSlack })
      for (const t of slackTools) {
        if (enabledSlack.includes(t.name)) {
          tools.push(t)
          activated.push({ name: t.name, source: 'connector' })
          unresolved.delete(t.name)
        }
      }
      unresolved.delete('slack')
      unresolved.delete('slack:*')
      unresolved.delete('connector:slack')
    }
  }

  const enabledHttp = pickEnabled(requested, HTTP_TOOL_NAMES, 'http')
  if (enabledHttp.length > 0 && connectors) {
    const {
      profile: httpProfile,
      profileName: httpProfileName,
      warnings: profileWarnings,
    } = selectHttpConnectorProfile(context)
    warnings.push(...profileWarnings)

    if (!httpProfile) {
      warnings.push('HTTP connector requested but no server-side HTTP connector profile or DZIP_HTTP_BASE_URL is configured.')
    } else {
      const policy = await validateMcpHttpEndpoint(
        httpProfile.baseUrl,
        'http',
        httpProfile.allowedHosts ? { allowedHosts: httpProfile.allowedHosts } : undefined,
      )
      if (!policy.ok) {
        warnings.push(`HTTP connector profile "${httpProfileName ?? 'unknown'}" rejected: ${policy.reason}`)
      } else if (typeof connectors['createHTTPConnector'] === 'function') {
        const httpConfig = {
          baseUrl: httpProfile.baseUrl,
          ...(httpProfile.headers ? { headers: httpProfile.headers } : {}),
          ...(httpProfile.allowedMethods ? { allowedMethods: httpProfile.allowedMethods } : {}),
          ...(httpProfile.timeoutMs !== undefined ? { timeoutMs: httpProfile.timeoutMs } : {}),
        }
        const httpTools = (connectors['createHTTPConnector'] as (
          cfg: {
            baseUrl: string
            headers?: Record<string, string>
            allowedMethods?: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>
            timeoutMs?: number
          },
        ) => StructuredToolInterface[])(httpConfig)
        for (const t of httpTools) {
          if (enabledHttp.includes(t.name)) {
            tools.push(t)
            activated.push({ name: t.name, source: 'connector' })
            unresolved.delete(t.name)
          }
        }
        unresolved.delete('http')
        unresolved.delete('http:*')
        unresolved.delete('connector:http')
      }
    }
  }

  const mcpResult = await resolveMcpTools(requested, context)
  for (const t of mcpResult.tools) {
    tools.push(t)
    activated.push({ name: t.name, source: 'mcp' })
    unresolved.delete(t.name)
  }
  for (const token of mcpResult.resolved) {
    unresolved.delete(token)
  }
  warnings.push(...mcpResult.warnings)
  const mcpCleanup = mcpResult.cleanup

  if (customResolver) {
    await applyCustomToolResolver({
      context,
      customResolver,
      tools,
      activated,
      unresolved,
    })
  }

  if (unresolved.size > 0) {
    warnings.push(
      'Some requested tools are unresolved by runtime resolver. ' +
      'Provide createDzupAgentRunExecutor({ toolResolver }) to map tool names to concrete tools.',
    )
  }

  const result: ToolResolverResult = {
    tools,
    activated,
    unresolved: [...unresolved],
    warnings,
    cleanup: mcpCleanup,
  }

  if (options?.resolvePolicy === 'strict' && result.unresolved.length > 0) {
    throw new ToolResolutionError(result.unresolved, result.warnings)
  }

  return result
}
