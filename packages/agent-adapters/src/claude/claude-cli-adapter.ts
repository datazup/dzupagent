import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { McpServerDescriptor } from '@dzupagent/runtime-contracts'
import { ForgeError } from '@dzupagent/core/events'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentEvent,
  AgentInput,
  HealthStatus,
  SessionInfo,
  TokenUsage,
} from '../types.js'
import { BaseCliAdapter, type PreparedCliRun } from '../base/base-cli-adapter.js'
import { createTemporaryProjection } from '../cli-runtime/temporary-projection.js'
import { getDefaultMonitorStatus } from '../provider-catalog.js'
import { serializeProviderPayload } from '../utils/provider-event-normalization.js'

const execFileAsync = promisify(execFile)
const MUTATING_TOOLS = ['Write', 'Edit', 'Bash', 'NotebookEdit'] as const

export interface ClaudeCliAdapterConfig extends AdapterConfig {
  /** Defaults to `claude`; injectable for managed installations and tests. */
  cliPath?: string | undefined
  /** Strict JSONL is the canonical backend default. */
  malformedLinePolicy?: 'skip' | 'error' | undefined
}

/** Direct local-subscription Claude Code backend. The SDK adapter remains separate. */
export class ClaudeCliAdapter extends BaseCliAdapter {
  private readonly cliPath: string
  private readonly malformedLinePolicy: 'skip' | 'error'

  constructor(config: ClaudeCliAdapterConfig = {}) {
    super('claude', config)
    this.cliPath = config.cliPath ?? 'claude'
    this.malformedLinePolicy = config.malformedLinePolicy ?? 'error'
  }

  protected getBinaryName(): string { return this.cliPath }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      nativeToolControls: { mode: true, allowlist: false, blocklist: true },
    }
  }

  protected buildArgs(input: AgentInput): string[] {
    const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    const sandbox = input.policyContext?.activePolicy?.sandboxMode
      ?? (typeof input.options?.['sandboxMode'] === 'string' ? input.options['sandboxMode'] : this.config.sandboxMode)
      ?? 'read-only'
    const allowedTools = input.policyContext?.activePolicy?.allowedTools ?? stringArray(input.options?.['allowedTools'])
    const blockedTools = input.policyContext?.activePolicy?.blockedTools ?? stringArray(input.options?.['blockedTools'])
    const blockedMcpTools = readMcpDescriptors(input).flatMap((server) =>
      (server.disabledTools ?? []).map((tool) => `mcp__${server.id}__${tool}`),
    )
    if (input.maxTurns !== undefined) throw unsupported('Claude CLI does not expose a deterministic max-turns flag')

    if (sandbox === 'read-only') {
      args.push('--disallowedTools', ...new Set([...MUTATING_TOOLS, ...blockedTools, ...blockedMcpTools]))
      if (allowedTools.length > 0) args.push('--allowedTools', ...allowedTools)
    }
    else if (sandbox === 'workspace-write') {
      if (allowedTools.length > 0 && input.policyContext?.conformanceMode === 'strict') {
        throw unsupported('Claude --allowedTools auto-approves tools but does not enforce a strict allowlist')
      }
      if (allowedTools.length > 0) args.push('--allowedTools', ...allowedTools)
      else args.push('--disallowedTools', 'Bash', ...blockedTools, ...blockedMcpTools)
    } else {
      if (blockedTools.length > 0 || blockedMcpTools.length > 0) args.push('--disallowedTools', ...blockedTools, ...blockedMcpTools)
    }

    if (input.workingDirectory) args.push('--add-dir', input.workingDirectory)
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId)
    if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt)
    const model = stringOption(input.options?.['model']) ?? this.config.model
    if (model) args.push('--model', model)
    if (this.config.reasoning) args.push('--effort', this.config.reasoning)
    if (input.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(input.maxBudgetUsd))
    if (input.outputSchema) args.push('--json-schema', JSON.stringify(input.outputSchema))
    // Stop variadic options such as --disallowedTools from consuming the prompt.
    args.push('--', input.prompt)
    return args
  }

  protected override async prepareCliRun(input: AgentInput): Promise<PreparedCliRun> {
    const args = this.buildArgs(input)
    const descriptors = readMcpDescriptors(input)
    if (descriptors.length === 0) return { args, cwd: input.workingDirectory ?? this.config.workingDirectory, env: this.buildSpawnEnv(input), malformedLinePolicy: this.malformedLinePolicy }

    const referenceValues = readReferenceValues(input)
    const config = buildClaudeMcpConfig(descriptors, referenceValues)
    const projection = await createTemporaryProjection('dzupagent-claude-', {
      mcp: { path: 'mcp.json', content: JSON.stringify(config), mode: 0o600 },
    })
    const optionBoundary = args.lastIndexOf('--')
    return {
      args: [...args.slice(0, optionBoundary), '--mcp-config', projection.paths['mcp']!, ...args.slice(optionBoundary)],
      cwd: input.workingDirectory ?? this.config.workingDirectory,
      env: this.buildSpawnEnv(input),
      malformedLinePolicy: this.malformedLinePolicy,
      cleanup: () => projection.cleanup(),
    }
  }

  protected mapProviderEvent(record: Record<string, unknown>, fallbackSessionId: string): AgentEvent | AgentEvent[] | undefined {
    const eventType = typeof record['type'] === 'string' ? record['type'] : ''
    const sessionId = typeof record['session_id'] === 'string' ? record['session_id'] : fallbackSessionId
    if (eventType === 'system' && record['subtype'] === 'init') return undefined
    if (eventType === 'stream_event') return mapStreamEvent(record)
    if (eventType === 'assistant') return mapAssistant(record)
    if (eventType === 'user') return mapToolResults(record)
    if (eventType === 'result') {
      const failed = record['is_error'] === true || record['subtype'] === 'error'
      if (failed) return { type: 'adapter:failed', providerId: 'claude', sessionId, error: String(record['result'] ?? record['error'] ?? 'Claude CLI execution failed'), code: classifyClaudeError(record), timestamp: Date.now() }
      return {
        type: 'adapter:completed', providerId: 'claude', sessionId,
        result: serializeProviderPayload(record['structured_output'] ?? record['result'] ?? '') ?? '',
        usage: mapUsage(record['usage']),
        durationMs: numberValue(record['duration_ms']), timestamp: Date.now(),
      }
    }
    return undefined
  }

  override async healthCheck(): Promise<HealthStatus> {
    const auth = await probeClaudeCliAuth(this.cliPath)
    return {
      healthy: auth.available && auth.authenticated,
      providerId: 'claude', sdkInstalled: auth.available, cliAvailable: auth.available,
      ...(!auth.available || !auth.authenticated ? { lastError: auth.reason } : {}),
      monitorStatus: getDefaultMonitorStatus('claude'),
    }
  }

  async listSessions(): Promise<SessionInfo[]> { return [] }
  async forkSession(): Promise<string> { throw unsupported('Claude CLI session forking is not exposed by this backend') }
}

export function createClaudeCliAdapter(config: ClaudeCliAdapterConfig = {}): ClaudeCliAdapter {
  return new ClaudeCliAdapter(config)
}

export async function probeClaudeCliAuth(cliPath = 'claude', timeoutMs = 5_000): Promise<{ available: boolean; authenticated: boolean; reason?: string }> {
  try {
    await execFileAsync(cliPath, ['--version'], { timeout: timeoutMs })
  } catch {
    return { available: false, authenticated: false, reason: 'Claude CLI binary not found or not executable' }
  }
  try {
    await execFileAsync(cliPath, ['auth', 'status'], { timeout: timeoutMs })
    return { available: true, authenticated: true }
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    return { available: true, authenticated: false, reason: typeof stderr === 'string' && stderr.trim() ? stderr.trim().slice(0, 512) : 'Claude CLI local authentication is unavailable or expired' }
  }
}

function mapAssistant(record: Record<string, unknown>): AgentEvent[] | undefined {
  const message = objectValue(record['message'])
  const content = Array.isArray(message?.['content']) ? message['content'] : []
  const events: AgentEvent[] = []
  for (const item of content) {
    const part = objectValue(item)
    if (part?.['type'] === 'text' && typeof part['text'] === 'string') events.push({ type: 'adapter:message', providerId: 'claude', content: part['text'], role: 'assistant', timestamp: Date.now() })
    if (part?.['type'] === 'tool_use') events.push({ type: 'adapter:tool_call', providerId: 'claude', toolName: String(part['name'] ?? 'unknown'), toolCallId: typeof part['id'] === 'string' ? part['id'] : undefined, input: part['input'] ?? {}, timestamp: Date.now() })
  }
  return events.length > 0 ? events : undefined
}

function mapToolResults(record: Record<string, unknown>): AgentEvent[] | undefined {
  const message = objectValue(record['message'])
  const content = Array.isArray(message?.['content']) ? message['content'] : []
  const events: AgentEvent[] = []
  for (const item of content) {
    const part = objectValue(item)
    if (part?.['type'] === 'tool_result') events.push({ type: 'adapter:tool_result', providerId: 'claude', toolName: String(part['tool_name'] ?? 'unknown'), toolCallId: typeof part['tool_use_id'] === 'string' ? part['tool_use_id'] : undefined, output: serializeProviderPayload(part['content']) ?? '', durationMs: 0, timestamp: Date.now() })
  }
  return events.length > 0 ? events : undefined
}

function mapStreamEvent(record: Record<string, unknown>): AgentEvent | undefined {
  const event = objectValue(record['event'])
  if (event?.['type'] !== 'content_block_delta') return undefined
  const delta = objectValue(event['delta'])
  const text = typeof delta?.['text'] === 'string' ? delta['text'] : undefined
  return text ? { type: 'adapter:stream_delta', providerId: 'claude', content: text, timestamp: Date.now() } : undefined
}

function buildClaudeMcpConfig(descriptors: readonly McpServerDescriptor[], refs: Readonly<Record<string, string>>): Record<string, unknown> {
  const servers: Record<string, unknown> = {}
  for (const descriptor of descriptors) {
    if (descriptor.enabledTools?.length) throw unsupported(`Claude CLI cannot strictly enforce enabledTools for MCP server ${descriptor.id}`)
    const transport = descriptor.transport
    if (transport.kind === 'stdio') {
      servers[descriptor.id] = { type: 'stdio', command: transport.command, args: [...(transport.args ?? [])], env: resolveReferences(transport.envRefs, refs) }
    } else {
      const headers = resolveReferences(transport.headerRefs, refs)
      if (transport.bearerTokenEnv) {
        if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
          throw unsupported(`MCP server ${descriptor.id} declares both Authorization headerRefs and bearerTokenEnv`)
        }
        const token = refs[transport.bearerTokenEnv.tokenRef]
        if (!token || /[\0\r\n]/u.test(token)) throw unsupported(`Unresolved or invalid local MCP reference: ${transport.bearerTokenEnv.tokenRef}`)
        headers.Authorization = `Bearer ${token}`
      }
      servers[descriptor.id] = { type: 'http', url: transport.url, headers }
    }
  }
  return { mcpServers: servers }
}

function resolveReferences(mapping: Readonly<Record<string, string>> | undefined, refs: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, reference] of Object.entries(mapping ?? {})) {
    const value = refs[reference]
    if (value === undefined) throw unsupported(`Unresolved local MCP reference: ${reference}`)
    result[name] = value
  }
  return result
}

function readMcpDescriptors(input: AgentInput): readonly McpServerDescriptor[] {
  const value = input.options?.['mcpServers']
  return Array.isArray(value) ? value as McpServerDescriptor[] : []
}
function readReferenceValues(input: AgentInput): Readonly<Record<string, string>> {
  const value = input.options?.['mcpReferenceValues']
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [] }
function stringOption(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function objectValue(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function mapUsage(value: unknown): TokenUsage | undefined {
  const usage = objectValue(value)
  if (!usage) return undefined
  const inputTokens = numberValue(usage['input_tokens'])
  const outputTokens = numberValue(usage['output_tokens'])
  return { inputTokens, outputTokens }
}
function classifyClaudeError(record: Record<string, unknown>): string {
  const text = String(record['result'] ?? record['error'] ?? '').toLowerCase()
  if (text.includes('auth') || text.includes('login')) return 'ADAPTER_AUTH_FAILED'
  return 'ADAPTER_EXECUTION_FAILED'
}
function unsupported(message: string): ForgeError { return new ForgeError({ code: 'CAPABILITY_DENIED', message, recoverable: false, context: { providerId: 'claude', backend: 'cli' } }) }
