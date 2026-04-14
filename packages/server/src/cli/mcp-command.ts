/**
 * MCP CLI command module — programmatic functions for managing MCP servers
 * and profiles via the McpManager interface.
 *
 * Each function takes an injected McpManager instance and returns typed results.
 * No framework-specific CLI parser code; pure business logic callable by any runner.
 */
import type {
  McpManager,
  McpServerDefinition,
  McpServerInput,
  McpServerPatch,
  McpProfile,
  McpTestResult,
} from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface McpCommandResult<T = void> {
  success: boolean
  data?: T | undefined
  error?: string | undefined
}

// ---------------------------------------------------------------------------
// Server operations
// ---------------------------------------------------------------------------

export async function mcpList(
  manager: McpManager,
): Promise<McpCommandResult<McpServerDefinition[]>> {
  try {
    const servers = await manager.listServers()
    return { success: true, data: servers }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function mcpAdd(
  manager: McpManager,
  input: McpServerInput,
): Promise<McpCommandResult<McpServerDefinition>> {
  try {
    const server = await manager.addServer(input)
    return { success: true, data: server }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function mcpUpdate(
  manager: McpManager,
  id: string,
  patch: McpServerPatch,
): Promise<McpCommandResult<McpServerDefinition>> {
  try {
    const server = await manager.updateServer(id, patch)
    return { success: true, data: server }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function mcpRemove(
  manager: McpManager,
  id: string,
): Promise<McpCommandResult> {
  try {
    await manager.removeServer(id)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function mcpEnable(
  manager: McpManager,
  id: string,
): Promise<McpCommandResult<McpServerDefinition>> {
  try {
    const server = await manager.enableServer(id)
    return { success: true, data: server }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function mcpDisable(
  manager: McpManager,
  id: string,
): Promise<McpCommandResult<McpServerDefinition>> {
  try {
    const server = await manager.disableServer(id)
    return { success: true, data: server }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function mcpTest(
  manager: McpManager,
  id: string,
): Promise<McpCommandResult<McpTestResult>> {
  try {
    const result = await manager.testServer(id)
    return { success: true, data: result }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

// ---------------------------------------------------------------------------
// Profile operations (bind/unbind map to addProfile/removeProfile)
// ---------------------------------------------------------------------------

export async function mcpBind(
  manager: McpManager,
  profile: McpProfile,
): Promise<McpCommandResult<McpProfile>> {
  try {
    const created = await manager.addProfile(profile)
    return { success: true, data: created }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function mcpUnbind(
  manager: McpManager,
  profileId: string,
): Promise<McpCommandResult> {
  try {
    await manager.removeProfile(profileId)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

// ---------------------------------------------------------------------------
// Formatters for terminal output
// ---------------------------------------------------------------------------

export function formatServerList(servers: McpServerDefinition[]): string {
  if (servers.length === 0) return 'No MCP servers registered.'

  const lines: string[] = [`MCP Servers (${servers.length}):`]
  for (const s of servers) {
    const status = s.enabled ? '\u2713 enabled' : '\u2717 disabled'
    const transport = s.transport ?? 'unknown'
    lines.push(`  ${s.id}  [${transport}]  ${status}  ${s.name ?? s.id}`)
    if (s.endpoint) lines.push(`    endpoint: ${s.endpoint}`)
    if (s.tags?.length) lines.push(`    tags: ${s.tags.join(', ')}`)
  }
  return lines.join('\n')
}

export function formatTestResult(id: string, result: McpTestResult): string {
  if (result.ok) {
    const tools = result.toolCount !== undefined ? ` (${result.toolCount} tools)` : ''
    return `\u2713 Server "${id}" is reachable${tools}`
  }
  return `\u2717 Server "${id}" test failed: ${result.error ?? 'unknown error'}`
}

export function formatProfileList(profiles: McpProfile[]): string {
  if (profiles.length === 0) return 'No MCP profiles defined.'

  const lines: string[] = [`MCP Profiles (${profiles.length}):`]
  for (const p of profiles) {
    const status = p.enabled ? '\u2713 enabled' : '\u2717 disabled'
    lines.push(`  ${p.id}  ${status}  servers: [${p.serverIds.join(', ')}]`)
    if (p.toolSelectors?.length) {
      lines.push(`    selectors: ${p.toolSelectors.join(', ')}`)
    }
  }
  return lines.join('\n')
}
