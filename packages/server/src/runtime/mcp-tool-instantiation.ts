import type { StructuredToolInterface } from '@langchain/core/tools'
import { validateMcpHttpEndpoint } from '../security/mcp-url-policy.js'
import { importFirstAvailable } from './runtime-module-imports.js'

export interface McpToolResolverContext {
  metadata?: Record<string, unknown>
  env?: NodeJS.ProcessEnv
}

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

interface McpMetadataPolicy {
  allowMetadataStdio: boolean
  allowedServerIds?: Set<string>
  allowedHttpHosts?: Set<string>
  allowedStdioCommands?: Set<string>
}

function parseMcpCategory(token: string): { serverFilter?: string; toolFilter?: string } | null {
  if (token === 'mcp' || token === 'mcp:*') return {}
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^mcp:([^:]+)(?::(.+))?$/.exec(token)
  if (!match) return null
  return { serverFilter: match[1], toolFilter: match[2] }
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function parseCsvEnvSet(value: string | undefined, normalize?: (value: string) => string): Set<string> | undefined {
  if (!value) return undefined
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => normalize ? normalize(entry) : entry)
  return entries.length > 0 ? new Set(entries) : undefined
}

function parseMcpMetadataPolicy(env: NodeJS.ProcessEnv | undefined): McpMetadataPolicy {
  return {
    allowMetadataStdio: parseBooleanEnv(env?.['DZIP_MCP_ALLOW_METADATA_STDIO']),
    allowedServerIds: parseCsvEnvSet(env?.['DZIP_MCP_ALLOWED_SERVER_IDS']),
    allowedHttpHosts: parseCsvEnvSet(env?.['DZIP_MCP_ALLOWED_HTTP_HOSTS'], value => value.toLowerCase()),
    allowedStdioCommands: parseCsvEnvSet(env?.['DZIP_MCP_ALLOWED_STDIO_COMMANDS']),
  }
}

async function extractMcpServers(
  metadata: Record<string, unknown> | undefined,
  policy: McpMetadataPolicy,
): Promise<{ servers: McpServerEntry[]; warnings: string[] }> {
  const warnings: string[] = []
  if (!metadata) return { servers: [], warnings }
  const raw = metadata['mcpServers']
  if (!Array.isArray(raw)) return { servers: [], warnings }

  const servers: McpServerEntry[] = []
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') {
      warnings.push(`Ignoring metadata.mcpServers[${index}] because it is not an object.`)
      continue
    }

    const record = entry as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'].trim() : ''
    const name = typeof record['name'] === 'string' && record['name'].trim().length > 0
      ? record['name'].trim()
      : undefined
    const url = typeof record['url'] === 'string' ? record['url'].trim() : ''

    if (!id || !url) {
      warnings.push(`Ignoring metadata.mcpServers[${index}] because "id" and "url" must be non-empty strings.`)
      continue
    }

    if (
      policy.allowedServerIds
      && !policy.allowedServerIds.has(id)
      && (!name || !policy.allowedServerIds.has(name))
    ) {
      warnings.push(`Ignoring MCP server "${id}" because it is not in DZIP_MCP_ALLOWED_SERVER_IDS.`)
      continue
    }

    const rawTransport = record['transport']
    const transport = rawTransport === undefined
      ? 'http'
      : rawTransport === 'http' || rawTransport === 'sse' || rawTransport === 'stdio'
        ? rawTransport
        : undefined

    if (!transport) {
      warnings.push(`Ignoring MCP server "${id}" because transport "${String(rawTransport)}" is invalid.`)
      continue
    }

    if (transport === 'stdio') {
      if (!policy.allowMetadataStdio) {
        warnings.push(`Ignoring MCP server "${id}" because metadata-defined stdio transport is disabled by policy.`)
        continue
      }
      const command = url.split(/\s+/, 1)[0] ?? ''
      if (!command) {
        warnings.push(`Ignoring MCP server "${id}" because stdio command is empty.`)
        continue
      }
      if (policy.allowedStdioCommands && !policy.allowedStdioCommands.has(command)) {
        warnings.push(`Ignoring MCP server "${id}" because command "${command}" is not in DZIP_MCP_ALLOWED_STDIO_COMMANDS.`)
        continue
      }
    } else {
      const result = await validateMcpHttpEndpoint(url, transport, { allowedHosts: policy.allowedHttpHosts })
      if (!result.ok) {
        warnings.push(`Ignoring MCP server "${id}" because ${result.reason}`)
        continue
      }
    }

    const rawArgs = record['args']
    const args = Array.isArray(rawArgs)
      ? rawArgs.filter((value): value is string => typeof value === 'string')
      : undefined
    if (Array.isArray(rawArgs) && rawArgs.length !== args?.length) {
      warnings.push(`MCP server "${id}" has non-string args entries; invalid entries were dropped.`)
    }

    const timeoutMs = typeof record['timeoutMs'] === 'number' && Number.isFinite(record['timeoutMs'])
      ? record['timeoutMs']
      : undefined
    const maxEagerTools = typeof record['maxEagerTools'] === 'number' && Number.isFinite(record['maxEagerTools'])
      ? record['maxEagerTools']
      : undefined

    servers.push({
      id,
      name,
      url,
      transport,
      args,
      timeoutMs,
      maxEagerTools,
    })
    if (record['env'] !== undefined || record['headers'] !== undefined) {
      warnings.push(`MCP server "${id}" metadata credential fields were ignored; use server-side MCP profiles or secret references.`)
    }
  }

  return { servers, warnings }
}

export async function resolveMcpTools(
  requested: Set<string>,
  context: McpToolResolverContext,
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

  const mcpPatterns: Array<{ token: string; serverFilter?: string; toolFilter?: string }> = []
  for (const token of requested) {
    const parsed = parseMcpCategory(token)
    if (parsed) mcpPatterns.push({ token, ...parsed })
  }

  if (mcpPatterns.length === 0) return { tools, activated, resolved, warnings, cleanup: noop }

  for (const pat of mcpPatterns) resolved.push(pat.token)

  const mcpPolicy = parseMcpMetadataPolicy(context.env)
  const { servers, warnings: policyWarnings } = await extractMcpServers(context.metadata, mcpPolicy)
  warnings.push(...policyWarnings)
  if (servers.length === 0) {
    warnings.push('MCP tools requested but no servers configured in metadata.mcpServers.')
    return { tools, activated, resolved, warnings, cleanup: noop }
  }

  const corePkg = await importFirstAvailable(['@dzupagent/core'])
  if (!corePkg || typeof corePkg['MCPClient'] !== 'function' || typeof corePkg['mcpToolToLangChain'] !== 'function') {
    warnings.push('MCP tools requested but @dzupagent/core MCP infrastructure is not available.')
    return { tools, activated, resolved, warnings, cleanup: noop }
  }

  const MCPClientCtor = corePkg['MCPClient'] as new () => {
    addServer(config: McpServerEntry & { name: string; urlPolicy?: unknown }): unknown
    connect(serverId: string): Promise<boolean>
    getEagerTools(): Array<{ name: string; serverId: string; description: string; inputSchema: Record<string, unknown> }>
    disconnectAll(): Promise<void>
  }
  const mcpToolToLangChain = corePkg['mcpToolToLangChain'] as (
    descriptor: unknown,
    client: unknown,
  ) => StructuredToolInterface

  const client = new MCPClientCtor()

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
      urlPolicy: {
        allowedHosts: mcpPolicy.allowedHttpHosts,
      },
      timeoutMs: s.timeoutMs,
      maxEagerTools: s.maxEagerTools,
    })
  }

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

  // Build id→name reverse lookup so pattern matching works whether the caller
  // referenced the server by id or by its friendly name.
  const serverNameById = new Map<string, string>()
  for (const s of targetServers) {
    if (s.name) serverNameById.set(s.id, s.name)
  }

  const eagerTools = client.getEagerTools()
  for (const descriptor of eagerTools) {
    const serverName = serverNameById.get(descriptor.serverId)
    const matchesPattern = mcpPatterns.some((pat) => {
      if (pat.serverFilter) {
        const matchById = pat.serverFilter === descriptor.serverId
        const matchByName = serverName !== undefined && pat.serverFilter === serverName
        if (!matchById && !matchByName) return false
      }
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
