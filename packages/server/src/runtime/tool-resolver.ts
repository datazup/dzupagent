import type { StructuredToolInterface } from '@langchain/core/tools'

export interface ToolResolverContext {
  toolNames?: string[]
  metadata?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
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

function hasCategory(requested: Set<string>, category: string): boolean {
  return requested.has(category) || requested.has(`${category}:*`) || requested.has(`connector:${category}`)
}

function pickEnabled(
  requested: Set<string>,
  names: Set<string>,
  category: string,
): string[] {
  if (hasCategory(requested, category)) return [...names]
  return [...names].filter((name) => requested.has(name))
}

async function importFirstAvailable(paths: string[]): Promise<Record<string, unknown> | null> {
  for (const p of paths) {
    try {
      return await import(p)
    } catch {
      // try next candidate
    }
  }
  return null
}

async function resolveGitFactory(): Promise<{
  createGitTools: ((executor: unknown) => StructuredToolInterface[]) | null
  GitExecutor: (new (cfg?: { cwd?: string }) => unknown) | null
}> {
  const pkg = await importFirstAvailable(['@forgeagent/codegen'])
  if (pkg && typeof pkg['createGitTools'] === 'function' && typeof pkg['GitExecutor'] === 'function') {
    return {
      createGitTools: pkg['createGitTools'] as (executor: unknown) => StructuredToolInterface[],
      GitExecutor: pkg['GitExecutor'] as new (cfg?: { cwd?: string }) => unknown,
    }
  }

  // Dev-only monorepo fallbacks — only resolve when package isn't published
  const toolsMod = await importFirstAvailable(['../../../forgeagent-codegen/src/git/git-tools.ts'])
  const execMod = await importFirstAvailable(['../../../forgeagent-codegen/src/git/git-executor.ts'])
  if (
    toolsMod && execMod
    && typeof toolsMod['createGitTools'] === 'function'
    && typeof execMod['GitExecutor'] === 'function'
  ) {
    return {
      createGitTools: toolsMod['createGitTools'] as (executor: unknown) => StructuredToolInterface[],
      GitExecutor: execMod['GitExecutor'] as new (cfg?: { cwd?: string }) => unknown,
    }
  }

  return { createGitTools: null, GitExecutor: null }
}

// ---------------------------------------------------------------------------
// MCP server config from metadata
// ---------------------------------------------------------------------------

interface McpServerEntry {
  id: string
  name?: string
  url: string
  transport?: 'http' | 'sse' | 'stdio'
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  timeoutMs?: number
  maxEagerTools?: number
}

function parseMcpCategory(token: string): { serverFilter?: string; toolFilter?: string } | null {
  if (token === 'mcp' || token === 'mcp:*') return {}
  const match = /^mcp:([^:]+)(?::(.+))?$/.exec(token)
  if (!match) return null
  return { serverFilter: match[1], toolFilter: match[2] }
}

function extractMcpServers(metadata: Record<string, unknown> | undefined): McpServerEntry[] {
  if (!metadata) return []
  const raw = metadata['mcpServers']
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is McpServerEntry =>
      typeof entry === 'object' && entry !== null
      && typeof (entry as Record<string, unknown>)['id'] === 'string'
      && typeof (entry as Record<string, unknown>)['url'] === 'string',
  )
}

async function resolveMcpTools(
  requested: Set<string>,
  context: ToolResolverContext,
): Promise<{
  tools: StructuredToolInterface[]
  activated: Array<{ name: string; source: 'mcp' }>
  resolved: string[]
  warnings: string[]
  cleanup: () => Promise<void>
}> {
  const tools: StructuredToolInterface[] = []
  const activated: Array<{ name: string; source: 'mcp' }> = []
  const resolved: string[] = []
  const warnings: string[] = []
  const noop = async () => {}

  // Collect all mcp:* patterns from requested set
  const mcpPatterns: Array<{ token: string; serverFilter?: string; toolFilter?: string }> = []
  for (const token of requested) {
    const parsed = parseMcpCategory(token)
    if (parsed) mcpPatterns.push({ token, ...parsed })
  }

  if (mcpPatterns.length === 0) return { tools, activated, resolved, warnings, cleanup: noop }

  // Always mark mcp pattern tokens as resolved (they are category selectors, not tool names)
  for (const pat of mcpPatterns) resolved.push(pat.token)

  const servers = extractMcpServers(context.metadata)
  if (servers.length === 0) {
    warnings.push('MCP tools requested but no servers configured in metadata.mcpServers.')
    return { tools, activated, resolved, warnings, cleanup: noop }
  }

  // Dynamic import of @forgeagent/core MCP infrastructure
  const corePkg = await importFirstAvailable(['@forgeagent/core'])
  if (!corePkg || typeof corePkg['MCPClient'] !== 'function' || typeof corePkg['mcpToolToLangChain'] !== 'function') {
    warnings.push('MCP tools requested but @forgeagent/core MCP infrastructure is not available.')
    return { tools, activated, resolved, warnings, cleanup: noop }
  }

  const MCPClientCtor = corePkg['MCPClient'] as new () => {
    addServer(config: McpServerEntry & { name: string }): unknown
    connect(serverId: string): Promise<boolean>
    getEagerTools(): Array<{ name: string; serverId: string; description: string; inputSchema: Record<string, unknown> }>
    disconnectAll(): Promise<void>
  }
  const mcpToolToLangChain = corePkg['mcpToolToLangChain'] as (
    descriptor: unknown,
    client: unknown,
  ) => StructuredToolInterface

  const client = new MCPClientCtor()

  // Determine which servers to connect to
  const serverFilters = new Set<string>()
  let connectAll = false
  for (const pat of mcpPatterns) {
    if (!pat.serverFilter) {
      connectAll = true
      break
    }
    serverFilters.add(pat.serverFilter)
  }

  const targetServers = connectAll
    ? servers
    : servers.filter((s) => serverFilters.has(s.id) || serverFilters.has(s.name ?? s.id))

  for (const s of targetServers) {
    client.addServer({
      id: s.id,
      name: s.name ?? s.id,
      url: s.url,
      transport: s.transport ?? 'http',
      args: s.args,
      env: s.env,
      headers: s.headers,
      timeoutMs: s.timeoutMs,
      maxEagerTools: s.maxEagerTools,
    })
  }

  // Connect to all target servers
  const connectionResults = await Promise.all(
    targetServers.map(async (s) => {
      const ok = await client.connect(s.id)
      if (!ok) {
        warnings.push(`MCP server "${s.name ?? s.id}" (${s.url}) failed to connect.`)
      }
      return { id: s.id, ok }
    }),
  )

  if (connectionResults.every((r) => !r.ok)) {
    warnings.push('All MCP servers failed to connect.')
    return { tools, activated, resolved, warnings, cleanup: () => client.disconnectAll() }
  }

  // Collect eager tools and filter by patterns
  const eagerTools = client.getEagerTools()
  const toolFilters = new Set<string>()
  for (const pat of mcpPatterns) {
    if (pat.toolFilter) toolFilters.add(pat.toolFilter)
  }

  for (const descriptor of eagerTools) {
    // Apply server + tool filters
    const matchesPattern = mcpPatterns.some((pat) => {
      if (pat.serverFilter && pat.serverFilter !== descriptor.serverId) return false
      if (pat.toolFilter && pat.toolFilter !== descriptor.name) return false
      return true
    })
    if (!matchesPattern) continue

    const langChainTool = mcpToolToLangChain(descriptor, client)
    tools.push(langChainTool)
    activated.push({ name: descriptor.name, source: 'mcp' })
  }

  return {
    tools,
    activated,
    resolved,
    warnings,
    cleanup: () => client.disconnectAll(),
  }
}

// ---------------------------------------------------------------------------
// Connector factories
// ---------------------------------------------------------------------------

async function resolveConnectorFactory(): Promise<Record<string, unknown> | null> {
  const pkg = await importFirstAvailable(['@forgeagent/connectors'])
  if (pkg) return pkg

  // Dev-only monorepo fallbacks — only resolve when package isn't published
  const github = await importFirstAvailable(['../../../forgeagent-connectors/src/github/github-connector.ts'])
  const slack = await importFirstAvailable(['../../../forgeagent-connectors/src/slack/slack-connector.ts'])
  const http = await importFirstAvailable(['../../../forgeagent-connectors/src/http/http-connector.ts'])
  if (!github && !slack && !http) return null

  return {
    ...github,
    ...slack,
    ...http,
  }
}

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
  const requested = new Set((context.toolNames ?? []).map((name) => name.trim()).filter(Boolean))
  const unresolved = new Set(requested)
  const warnings: string[] = []
  const tools: StructuredToolInterface[] = []
  const activated: Array<{ name: string; source: ToolSource }> = []

  if (requested.size === 0 && !customResolver) {
    return { tools, activated, unresolved: [], warnings }
  }

  // Built-in git tools (default resolver)
  const wantGit = hasCategory(requested, 'git') || [...requested].some((name) => GIT_TOOL_NAMES.has(name))
  if (wantGit) {
    const { createGitTools, GitExecutor } = await resolveGitFactory()
    if (createGitTools && GitExecutor) {
      const cwd = typeof context.metadata?.['cwd'] === 'string'
        ? context.metadata['cwd']
        : process.cwd()
      const gitExec = new GitExecutor({ cwd })
      const gitTools = createGitTools(gitExec)
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
    } else {
      warnings.push('Git tools requested but @forgeagent/codegen is not available at runtime.')
    }
  }

  // Only attempt connector resolution if connector tools are actually requested
  const wantConnectors = [...requested].some((n) =>
    GITHUB_TOOL_NAMES.has(n) || SLACK_TOOL_NAMES.has(n) || HTTP_TOOL_NAMES.has(n)
      || hasCategory(requested, 'github')
      || hasCategory(requested, 'slack')
      || hasCategory(requested, 'http'),
  )

  const connectors = wantConnectors ? await resolveConnectorFactory() : null
  if (wantConnectors && !connectors) {
    warnings.push('Connector tools requested but @forgeagent/connectors is not available at runtime.')
  }

  // GitHub connector
  const enabledGithub = pickEnabled(requested, GITHUB_TOOL_NAMES, 'github')
  if (enabledGithub.length > 0 && connectors) {
    const token = (typeof context.metadata?.['githubToken'] === 'string' && context.metadata['githubToken'])
      || context.env?.['GITHUB_TOKEN']

    if (!token) {
      warnings.push('GitHub tools requested but no token provided (metadata.githubToken or GITHUB_TOKEN).')
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

  // Slack connector
  const enabledSlack = pickEnabled(requested, SLACK_TOOL_NAMES, 'slack')
  if (enabledSlack.length > 0 && connectors) {
    const token = (typeof context.metadata?.['slackToken'] === 'string' && context.metadata['slackToken'])
      || context.env?.['SLACK_BOT_TOKEN']

    if (!token) {
      warnings.push('Slack tools requested but no token provided (metadata.slackToken or SLACK_BOT_TOKEN).')
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

  // HTTP connector
  const enabledHttp = pickEnabled(requested, HTTP_TOOL_NAMES, 'http')
  if (enabledHttp.length > 0 && connectors) {
    const baseUrl = (typeof context.metadata?.['httpBaseUrl'] === 'string' && context.metadata['httpBaseUrl'])
      || context.env?.['FORGE_HTTP_BASE_URL']

    if (!baseUrl) {
      warnings.push('HTTP connector requested but no base URL provided (metadata.httpBaseUrl or FORGE_HTTP_BASE_URL).')
    } else if (typeof connectors['createHTTPConnector'] === 'function') {
      const headerRecord = context.metadata?.['httpHeaders']
      const headers = (headerRecord && typeof headerRecord === 'object' && !Array.isArray(headerRecord))
        ? Object.fromEntries(
            Object.entries(headerRecord)
              .filter(([, v]) => typeof v === 'string') as Array<[string, string]>,
          )
        : undefined

      const httpTools = (connectors['createHTTPConnector'] as (
        cfg: { baseUrl: string; headers?: Record<string, string> },
      ) => StructuredToolInterface[])({ baseUrl, headers })
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

  // MCP tools (mcp:*, mcp:server-name, mcp:server-name:tool-name)
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

  // Custom resolver hook — custom tools override built-in tools with the same name
  if (customResolver) {
    const custom = await customResolver(context)
    for (const t of custom) {
      const existingIdx = tools.findIndex((existing) => existing.name === t.name)
      if (existingIdx >= 0) {
        tools[existingIdx] = t
        const activatedIdx = activated.findIndex((a) => a.name === t.name)
        if (activatedIdx >= 0) activated[activatedIdx] = { name: t.name, source: 'custom' }
      } else {
        tools.push(t)
        activated.push({ name: t.name, source: 'custom' })
      }
      unresolved.delete(t.name)
    }
  }

  if (unresolved.size > 0) {
    warnings.push(
      'Some requested tools are unresolved by runtime resolver. ' +
      'Provide createForgeAgentRunExecutor({ toolResolver }) to map tool names to concrete tools.',
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
