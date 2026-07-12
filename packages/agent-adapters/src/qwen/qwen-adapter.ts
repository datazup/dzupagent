/**
 * Qwen Code CLI adapter for the local qwen-oauth subscription path.
 *
 * API-key-backed Qwen models remain an OpenAI-compatible ModelRegistry concern;
 * this adapter never injects or falls back to API credentials.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ForgeError } from '@dzupagent/core/events'
import type {
  AdapterConfig,
  AdapterCapabilityProfile,
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  TokenUsage,
} from '../types.js'
import { BaseCliAdapter, type PreparedCliRun } from '../base/base-cli-adapter.js'
import { createCliHomeProjection } from '../cli-runtime/index.js'
import type { CliRuntimeLimits } from '../cli-runtime/index.js'
import { isBinaryAvailable } from '../utils/process-helpers.js'
import {
  extractUsage,
  mapCliProviderEvent,
  serializeProviderPayload,
} from '../utils/provider-event-normalization.js'

const PROVIDER_ID: AdapterProviderId = 'qwen'
const QWEN_BINARY = 'qwen'
const QWEN_AUTH_TYPE = 'qwen-oauth'
const READ_ONLY_EXCLUSIONS = ['edit', 'write_file', 'run_shell_command', 'notebook_edit'] as const
const WORKSPACE_WRITE_EXCLUSIONS = ['run_shell_command'] as const
const API_CREDENTIAL_ENV_PATTERNS = [
  /^(?:DASHSCOPE|QWEN|OPENAI|ANTHROPIC|GEMINI|GOOGLE)_API_KEY$/u,
  /^QWEN_CUSTOM_API_KEY_/u,
  /^OPENAI_(?:BASE_URL|MODEL)$/u,
] as const

export interface QwenCliAdapterConfig extends AdapterConfig {
  /** Defaults to `qwen`; injectable for managed installations and tests. */
  cliPath?: string | undefined
  /** Approved Qwen profile root, normally ~/.qwen, copied into private QWEN_HOME. */
  cliBaseProfileRoot?: string | undefined
  /** Relative regular files copied from cliBaseProfileRoot. */
  cliBaseProfileFiles?: readonly string[] | undefined
  /** Strict JSONL is the canonical Qwen CLI backend default. */
  malformedLinePolicy?: 'skip' | 'error' | undefined
  /** Optional bounded-output overrides for deterministic harness tests. */
  runtimeLimits?: Partial<CliRuntimeLimits> | undefined
}

export class QwenAdapter extends BaseCliAdapter {
  private qwenConfig: QwenCliAdapterConfig

  constructor(config: QwenCliAdapterConfig = {}) {
    super(PROVIDER_ID, config)
    this.qwenConfig = { ...config }
  }

  configure(opts: Partial<AdapterConfig>): void {
    super.configure(opts)
    this.qwenConfig = { ...this.qwenConfig, ...opts }
  }

  protected getBinaryName(): string {
    return this.qwenConfig.cliPath ?? QWEN_BINARY
  }

  protected async assertReady(input?: AgentInput): Promise<void> {
    await super.assertReady(input)
    const binary = this.getBinaryName()
    const available = await isBinaryAvailable(binary)
    if (!available) {
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message: `'${binary}' binary not found in PATH`,
        recoverable: false,
        suggestion: 'Install Qwen Code for subscription execution, or use a separately configured OpenAI-compatible provider for API-key execution',
        context: { command: binary, providerId: PROVIDER_ID, backend: 'cli' },
      })
    }
  }

  protected getUnavailableBinaryMessage(binary: string): string {
    return `'${binary}' binary not found in PATH. Qwen API models require a separately configured OpenAI-compatible provider.`
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | AgentEvent[] | undefined {
    return mapQwenEvent(record, sessionId)
      ?? mapCliProviderEvent(record, sessionId, {
        providerId: PROVIDER_ID,
        extraToolNameKeys: ['function'],
        defaultErrorMessage: 'Unknown Qwen CLI error',
      })
  }

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

  protected buildArgs(input: AgentInput, outputSchemaPath?: string): string[] {
    this.validateSupportedPolicy(input)
    const args = [
      '--bare',
      '--auth-type', QWEN_AUTH_TYPE,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--approval-mode', this.resolveApprovalMode(input),
    ]

    if (this.resolveSandbox(input) !== 'full-access') args.push('--sandbox')
    const excludedTools = this.resolveExcludedTools(input)
    if (excludedTools.length > 0) args.push('--exclude-tools', ...excludedTools)
    if (input.systemPrompt) args.push('--system-prompt', input.systemPrompt)
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId)
    if (this.config.model) args.push('--model', this.config.model)
    if (input.maxTurns !== undefined) args.push('--max-session-turns', String(input.maxTurns))
    if (outputSchemaPath) args.push('--json-schema', `@${outputSchemaPath}`)
    args.push('--prompt', input.prompt)
    return args
  }

  protected async prepareCliRun(input: AgentInput): Promise<PreparedCliRun> {
    this.validateSupportedPolicy(input)
    const cwd = input.workingDirectory ?? this.config.workingDirectory
    if (this.resolveSandbox(input) !== 'read-only' && !cwd) {
      throw policyRejected('Qwen CLI write access requires an explicit working directory', 'missing_working_directory')
    }

    const baseProfileInputs = await this.buildBaseProfileInputs()
    const outputSchema = input.outputSchema === undefined ? undefined : JSON.stringify(input.outputSchema)
    const projection = await createCliHomeProjection({
      prefix: 'dzupagent-qwen-',
      envVar: 'QWEN_HOME',
      approvedBaseProfileRoots: this.qwenConfig.cliBaseProfileRoot
        ? [this.qwenConfig.cliBaseProfileRoot]
        : [],
      baseProfileInputs,
      requiredDirectories: ['tmp', 'todos', 'debug'],
      generatedFiles: outputSchema === undefined ? undefined : {
        outputSchema: { path: 'dzupagent/output-schema.json', content: `${outputSchema}\n` },
      },
    })

    try {
      const env = {
        ...this.buildSpawnEnv(input),
        ...projection.env,
        QWEN_RUNTIME_DIR: projection.root,
        QWEN_CODE_DISABLE_PRECONNECT: '1',
        QWEN_CODE_UNATTENDED_RETRY: '0',
        QWEN_TELEMETRY_ENABLED: '0',
      }
      for (const key of Object.keys(env)) {
        if (API_CREDENTIAL_ENV_PATTERNS.some((pattern) => pattern.test(key))) delete env[key]
      }
      return {
        args: this.buildArgs(input, projection.generatedPaths['outputSchema']),
        cwd,
        env,
        cleanup: () => projection.cleanup(),
        malformedLinePolicy: this.qwenConfig.malformedLinePolicy ?? 'error',
        limits: this.qwenConfig.runtimeLimits,
      }
    } catch (error) {
      await projection.cleanup().catch(() => undefined)
      throw error
    }
  }

  private validateSupportedPolicy(input: AgentInput): void {
    if (this.config.apiKey) {
      throw policyRejected('Qwen CLI subscription execution does not accept API keys; use an OpenAI-compatible API provider', 'api_key_backend_mismatch')
    }
    const sandbox = this.resolveSandbox(input)
    if (!['read-only', 'workspace-write', 'full-access'].includes(sandbox)) {
      throw policyRejected(`Qwen CLI backend does not support sandbox mode: ${sandbox}`, 'unsupported_sandbox')
    }
    const policy = input.policyContext?.activePolicy
    if (policy?.allowedTools?.length) {
      throw policyRejected('Qwen --allowed-tools bypasses confirmation and is not a strict allowlist', 'unsupported_tool_allowlist')
    }
    if (policy?.networkAccess === false) {
      throw policyRejected('Qwen CLI 0.17.1 does not expose deterministic network isolation', 'unsupported_network_policy')
    }
    if (input.maxBudgetUsd !== undefined || policy?.maxBudgetUsd !== undefined) {
      throw policyRejected('Qwen CLI 0.17.1 does not expose a deterministic cost budget', 'unsupported_budget')
    }
    if (readMcpDescriptors(input).length > 0) {
      throw policyRejected('Qwen ignores --mcp-config in the required isolated bare mode', 'unsupported_isolated_mcp')
    }
    if (sandbox === 'full-access' && policy?.approvalRequired !== false) {
      throw policyRejected('Qwen full-access requires approvalRequired=false', 'approval_required_full_access')
    }
  }

  private resolveSandbox(input: AgentInput): 'read-only' | 'workspace-write' | 'full-access' {
    return input.policyContext?.activePolicy?.sandboxMode
      ?? stringOption(input.options?.['sandboxMode']) as 'read-only' | 'workspace-write' | 'full-access' | undefined
      ?? this.config.sandboxMode
      ?? 'read-only'
  }

  private resolveApprovalMode(input: AgentInput): 'plan' | 'default' | 'auto-edit' | 'yolo' {
    const sandbox = this.resolveSandbox(input)
    const approvalRequired = input.policyContext?.activePolicy?.approvalRequired
    if (sandbox === 'full-access') return 'yolo'
    if (sandbox === 'workspace-write') return approvalRequired === false ? 'auto-edit' : 'default'
    return 'plan'
  }

  private resolveExcludedTools(input: AgentInput): string[] {
    const sandbox = this.resolveSandbox(input)
    const policyBlocked = input.policyContext?.activePolicy?.blockedTools ?? stringArray(input.options?.['blockedTools'])
    const defaults = sandbox === 'read-only'
      ? READ_ONLY_EXCLUSIONS
      : sandbox === 'workspace-write'
        ? WORKSPACE_WRITE_EXCLUSIONS
        : []
    return [...new Set([...defaults, ...policyBlocked])]
  }

  private async buildBaseProfileInputs(): Promise<Record<string, { sourcePath: string; targetPath: string }>> {
    const root = this.qwenConfig.cliBaseProfileRoot
    if (!root) return {}
    await this.assertSubscriptionProfile(root)
    const files = this.qwenConfig.cliBaseProfileFiles
      ?? ['settings.json', 'oauth_creds.json', 'installation_id', 'output-language.md']
    const inputs: Record<string, { sourcePath: string; targetPath: string }> = {}
    for (const [index, relativePath] of files.entries()) {
      if (!relativePath || relativePath.startsWith('/') || relativePath.split(/[\\/]/u).includes('..')) {
        throw new Error(`Qwen base-profile file must be a contained relative path: ${relativePath}`)
      }
      if (relativePath === '.env' || relativePath.endsWith('/.env')) {
        throw policyRejected('Qwen profile .env files cannot enter subscription projections', 'profile_env_forbidden')
      }
      const sourcePath = join(root, relativePath)
      const info = await stat(sourcePath).catch(() => null)
      if (!info) continue
      if (!info.isFile()) throw new Error(`Qwen base-profile input must be a regular file: ${sourcePath}`)
      inputs[`baseProfile${index}`] = { sourcePath, targetPath: relativePath }
    }
    return inputs
  }

  private async assertSubscriptionProfile(root: string): Promise<void> {
    const settingsPath = join(root, 'settings.json')
    const raw = await readFile(settingsPath, 'utf8').catch(() => '')
    if (!raw) throw policyRejected('Qwen subscription profile requires settings.json', 'missing_subscription_settings')
    let settings: Record<string, unknown>
    try {
      settings = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw policyRejected('Qwen subscription settings.json is not valid JSON', 'invalid_subscription_settings')
    }
    const security = objectValue(settings['security'])
    const auth = objectValue(security?.['auth'])
    if (auth?.['selectedType'] !== QWEN_AUTH_TYPE) {
      throw policyRejected(`Qwen CLI profile must select ${QWEN_AUTH_TYPE}`, 'non_subscription_profile')
    }
  }
}

export function createQwenCliAdapter(config: QwenCliAdapterConfig = {}): QwenAdapter {
  return new QwenAdapter(config)
}

function mapQwenEvent(record: Record<string, unknown>, fallbackSessionId: string): AgentEvent | AgentEvent[] | undefined {
  const type = typeof record['type'] === 'string' ? record['type'] : ''
  const sessionId = typeof record['session_id'] === 'string' ? record['session_id'] : fallbackSessionId
  if (type === 'system' && record['subtype'] === 'init') return undefined
  if (type === 'stream_event') {
    const event = objectValue(record['event'])
    if (event?.['type'] !== 'content_block_delta') return undefined
    const delta = objectValue(event['delta'])
    const content = typeof delta?.['text'] === 'string'
      ? delta['text']
      : typeof delta?.['thinking'] === 'string'
        ? delta['thinking']
        : undefined
    return content ? { type: 'adapter:stream_delta', providerId: PROVIDER_ID, content, timestamp: Date.now() } : undefined
  }
  if (type === 'assistant') return mapAssistant(record)
  if (type === 'user') return mapToolResults(record)
  if (type === 'result') {
    if (record['is_error'] === true) {
      const error = objectValue(record['error'])
      const message = typeof error?.['message'] === 'string' ? error['message'] : 'Qwen CLI execution failed'
      return {
        type: 'adapter:failed', providerId: PROVIDER_ID, sessionId, error: message,
        code: /auth|oauth|login/iu.test(message) ? 'ADAPTER_AUTH_FAILED' : 'ADAPTER_EXECUTION_FAILED',
        timestamp: Date.now(),
      }
    }
    return {
      type: 'adapter:completed', providerId: PROVIDER_ID, sessionId,
      result: serializeProviderPayload(record['structured_result'] ?? record['result'] ?? '') ?? '',
      usage: mapQwenUsage(record),
      durationMs: numberValue(record['duration_ms']), timestamp: Date.now(),
    }
  }
  return undefined
}

function mapAssistant(record: Record<string, unknown>): AgentEvent[] | undefined {
  const message = objectValue(record['message'])
  const content = Array.isArray(message?.['content']) ? message['content'] : []
  const events: AgentEvent[] = []
  for (const item of content) {
    const block = objectValue(item)
    if (block?.['type'] === 'text' && typeof block['text'] === 'string') {
      events.push({ type: 'adapter:message', providerId: PROVIDER_ID, content: block['text'], role: 'assistant', timestamp: Date.now() })
    }
    if (block?.['type'] === 'tool_use') {
      events.push({
        type: 'adapter:tool_call', providerId: PROVIDER_ID,
        toolName: typeof block['name'] === 'string' ? block['name'] : 'unknown',
        ...(typeof block['id'] === 'string' ? { toolCallId: block['id'] } : {}),
        input: block['input'] ?? {}, timestamp: Date.now(),
      })
    }
  }
  return events.length > 0 ? events : undefined
}

function mapToolResults(record: Record<string, unknown>): AgentEvent[] | undefined {
  const message = objectValue(record['message'])
  const content = Array.isArray(message?.['content']) ? message['content'] : []
  const events: AgentEvent[] = []
  for (const item of content) {
    const block = objectValue(item)
    if (block?.['type'] !== 'tool_result') continue
    const toolCallId = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : undefined
    events.push({
      type: 'adapter:tool_result', providerId: PROVIDER_ID,
      toolName: typeof block['tool_name'] === 'string' ? block['tool_name'] : toolCallId ?? 'unknown',
      ...(toolCallId ? { toolCallId } : {}),
      output: serializeProviderPayload(block['content'] ?? '') ?? '',
      durationMs: 0, timestamp: Date.now(),
    })
  }
  return events.length > 0 ? events : undefined
}

function mapQwenUsage(record: Record<string, unknown>): TokenUsage | undefined {
  return extractUsage(record)
}

function policyRejected(message: string, reason: string): ForgeError {
  return new ForgeError({
    code: 'CAPABILITY_DENIED', message, recoverable: false,
    context: { providerId: PROVIDER_ID, backend: 'cli', reason, telemetry: 'qwen_cli_policy_rejected' },
  })
}

function readMcpDescriptors(input: AgentInput): readonly unknown[] {
  const value = input.options?.['mcpServers']
  return Array.isArray(value) ? value : []
}
function stringOption(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [] }
function objectValue(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
