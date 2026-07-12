/**
 * Google Gemini CLI adapter.
 *
 * The CLI backend is intentionally separate from the API-key-backed Gemini SDK
 * adapter. Every execution receives a private GEMINI_CLI_HOME projection and
 * API credential environment variables are removed before spawn.
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ForgeError } from '@dzupagent/core/events'
import type {
  AdapterConfig,
  AdapterCapabilityProfile,
  AdapterProviderId,
  AgentEvent,
  AgentInput,
} from '../types.js'
import { BaseCliAdapter, type PreparedCliRun } from '../base/base-cli-adapter.js'
import { createCliHomeProjection } from '../cli-runtime/index.js'
import type { CliRuntimeLimits } from '../cli-runtime/index.js'
import { getNumber, getObject, getString } from '../utils/event-record.js'
import {
  readErrorCode,
  readErrorMessage,
  serializeProviderPayload,
} from '../utils/provider-event-normalization.js'

const PROVIDER_ID: AdapterProviderId = 'gemini'
const GEMINI_BINARY = 'gemini'
const API_CREDENTIAL_ENV_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const

export interface GeminiCliAdapterConfig extends AdapterConfig {
  /** Defaults to `gemini`; injectable for managed installations and tests. */
  cliPath?: string | undefined
  /** Optional approved Gemini profile directory (normally ~/.gemini). */
  cliBaseProfileRoot?: string | undefined
  /** Relative regular files copied below the projected .gemini directory. */
  cliBaseProfileFiles?: readonly string[] | undefined
  /** Strict JSONL is the canonical Gemini CLI backend default. */
  malformedLinePolicy?: 'skip' | 'error' | undefined
  /** Optional bounded-output overrides for deterministic harness tests. */
  runtimeLimits?: Partial<CliRuntimeLimits> | undefined
}

/** Map a raw Gemini stream-json record to the normalized adapter contract. */
function mapGeminiEvent(
  record: Record<string, unknown>,
  sessionId: string,
): AgentEvent | undefined {
  const type = getString(record, 'type', 'event')
  const tool = getObject(record, 'tool', 'function_call')
  const nestedResult = getObject(record, 'tool_result', 'function_response')

  switch (type) {
    case 'init':
      return undefined

    case 'message':
    case 'response': {
      const content = serializeProviderPayload(record['content'] ?? record['text'] ?? record['message'] ?? '')
        ?? ''
      if (record['delta'] === true) {
        return {
          type: 'adapter:stream_delta',
          providerId: PROVIDER_ID,
          content,
          timestamp: Date.now(),
        }
      }
      const role = record['role'] === 'user' || record['role'] === 'system'
        ? record['role']
        : 'assistant' as const
      return {
        type: 'adapter:message',
        providerId: PROVIDER_ID,
        content,
        role,
        timestamp: Date.now(),
      }
    }

    case 'tool_use':
    case 'tool_call':
    case 'function_call': {
      const toolName = getString(record, 'tool_name', 'name')
        ?? getString(tool ?? {}, 'name')
        ?? 'unknown'
      const toolCallId = getString(record, 'tool_id', 'tool_call_id')
      return {
        type: 'adapter:tool_call',
        providerId: PROVIDER_ID,
        toolName,
        ...(toolCallId ? { toolCallId } : {}),
        input: record['parameters'] ?? record['arguments'] ?? record['input']
          ?? tool?.['parameters'] ?? tool?.['arguments'] ?? tool?.['input']
          ?? {},
        timestamp: Date.now(),
      }
    }

    case 'tool_result':
    case 'function_response': {
      const toolCallId = getString(record, 'tool_id', 'tool_call_id')
      const toolName = getString(record, 'tool_name', 'name')
        ?? getString(nestedResult ?? {}, 'tool_name', 'name')
        ?? getString(tool ?? {}, 'name')
        ?? toolCallId
        ?? 'unknown'
      const providerError = getObject(record, 'error')
      const output = serializeProviderPayload(
        record['output'] ?? record['result'] ?? record['content']
        ?? providerError?.['message']
        ?? nestedResult?.['output'] ?? nestedResult?.['result'] ?? nestedResult?.['content']
        ?? '',
      ) ?? ''
      const durationMs = getNumber(record, 'duration_ms', 'durationMs', 'elapsed_ms')
        ?? getNumber(nestedResult ?? {}, 'duration_ms', 'durationMs', 'elapsed_ms')
        ?? 0
      return {
        type: 'adapter:tool_result',
        providerId: PROVIDER_ID,
        toolName,
        ...(toolCallId ? { toolCallId } : {}),
        output,
        durationMs,
        timestamp: Date.now(),
      }
    }

    case 'stream_delta':
    case 'delta': {
      return {
        type: 'adapter:stream_delta',
        providerId: PROVIDER_ID,
        content: getString(record, 'content', 'text', 'delta') ?? '',
        timestamp: Date.now(),
      }
    }

    case 'result': {
      if (record['status'] === 'error') {
        const providerError = getObject(record, 'error')
        return {
          type: 'adapter:failed',
          providerId: PROVIDER_ID,
          sessionId,
          error: getString(providerError ?? {}, 'message') ?? 'Gemini CLI result reported an error',
          ...(getString(providerError ?? {}, 'type') ? { code: getString(providerError ?? {}, 'type') } : {}),
          timestamp: Date.now(),
        }
      }
      const stats = getObject(record, 'stats')
      const inputTokens = getNumber(stats ?? {}, 'input_tokens')
      const outputTokens = getNumber(stats ?? {}, 'output_tokens')
      return {
        type: 'adapter:completed',
        providerId: PROVIDER_ID,
        sessionId,
        result: '',
        ...(inputTokens !== undefined && outputTokens !== undefined
          ? { usage: { inputTokens, outputTokens } }
          : {}),
        durationMs: getNumber(stats ?? {}, 'duration_ms') ?? 0,
        timestamp: Date.now(),
      }
    }

    case 'done':
    case 'completed': {
      return {
        type: 'adapter:completed',
        providerId: PROVIDER_ID,
        sessionId,
        result: serializeProviderPayload(
          record['result'] ?? record['content'] ?? record['output'] ?? record['text'] ?? '',
        ) ?? '',
        durationMs: getNumber(record, 'duration_ms', 'durationMs', 'elapsed_ms') ?? 0,
        timestamp: Date.now(),
      }
    }

    case 'error': {
      const errorCode = readErrorCode(record)
      return {
        type: 'adapter:failed',
        providerId: PROVIDER_ID,
        sessionId,
        error: readErrorMessage(record) ?? 'Unknown Gemini CLI error',
        ...(errorCode !== undefined ? { code: errorCode } : {}),
        timestamp: Date.now(),
      }
    }

    default:
      return undefined
  }
}

export class GeminiCLIAdapter extends BaseCliAdapter {
  private geminiConfig: GeminiCliAdapterConfig

  constructor(config: GeminiCliAdapterConfig = {}) {
    super(PROVIDER_ID, config)
    this.geminiConfig = { ...config }
  }

  configure(opts: Partial<AdapterConfig>): void {
    super.configure(opts)
    this.geminiConfig = { ...this.geminiConfig, ...opts }
  }

  protected getBinaryName(): string {
    return this.geminiConfig.cliPath ?? GEMINI_BINARY
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    return mapGeminiEvent(record, sessionId)
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      nativeToolControls: { mode: true, allowlist: false, blocklist: false },
    }
  }

  protected buildArgs(input: AgentInput): string[] {
    this.validateSupportedPolicy(input)
    const args = ['--output-format', 'stream-json']
    if (input.prompt) args.push('--prompt', input.prompt)
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId)
    if (this.config.model) args.push('--model', this.config.model)
    args.push('--approval-mode', this.resolveApprovalMode(input))
    if (this.resolveSandbox(input) !== 'full-access') args.push('--sandbox')
    return args
  }

  protected async prepareCliRun(input: AgentInput): Promise<PreparedCliRun> {
    this.validateSupportedPolicy(input)
    const cwd = input.workingDirectory ?? this.config.workingDirectory
    if (this.resolveSandbox(input) !== 'read-only' && !cwd) {
      throw policyRejected('Gemini CLI write access requires an explicit working directory', 'missing_working_directory')
    }
    const baseProfileInputs = await this.buildBaseProfileInputs()
    const projection = await createCliHomeProjection({
      prefix: 'dzupagent-gemini-',
      envVar: 'GEMINI_CLI_HOME',
      approvedBaseProfileRoots: this.geminiConfig.cliBaseProfileRoot
        ? [this.geminiConfig.cliBaseProfileRoot]
        : [],
      baseProfileInputs,
      requiredDirectories: ['.gemini/tmp', '.gemini/history'],
    })
    try {
      const env = { ...this.buildSpawnEnv(input), ...projection.env }
      for (const key of API_CREDENTIAL_ENV_KEYS) delete env[key]
      return {
        args: this.buildArgs(input),
        cwd,
        env,
        cleanup: () => projection.cleanup(),
        malformedLinePolicy: this.geminiConfig.malformedLinePolicy ?? 'error',
        limits: this.geminiConfig.runtimeLimits,
      }
    } catch (error) {
      await projection.cleanup().catch(() => undefined)
      throw error
    }
  }

  private validateSupportedPolicy(input: AgentInput): void {
    const sandbox = this.resolveSandbox(input)
    if (!['read-only', 'workspace-write', 'full-access'].includes(sandbox)) {
      throw policyRejected(`Gemini CLI backend does not support sandbox mode: ${sandbox}`, 'unsupported_sandbox')
    }
    if (input.systemPrompt !== undefined) {
      throw policyRejected('Gemini CLI 0.35.3 does not expose a system-prompt flag', 'unsupported_system_prompt')
    }
    if (input.maxTurns !== undefined || input.policyContext?.activePolicy?.maxTurns !== undefined) {
      throw policyRejected('Gemini CLI 0.35.3 does not expose a deterministic max-turns flag', 'unsupported_max_turns')
    }
    if (input.outputSchema !== undefined) {
      throw policyRejected('Gemini CLI 0.35.3 does not expose structured-output schema enforcement', 'unsupported_output_schema')
    }
    const policy = input.policyContext?.activePolicy
    if (policy?.allowedTools?.length || policy?.blockedTools?.length) {
      throw policyRejected('Gemini CLI tool allow/block projection is not proven by this adapter', 'unsupported_tool_policy')
    }
    if (readMcpDescriptors(input).length > 0) {
      throw policyRejected('Gemini CLI MCP descriptors are not projected by this adapter', 'unsupported_mcp')
    }
  }

  private resolveSandbox(input: AgentInput): 'read-only' | 'workspace-write' | 'full-access' {
    return input.policyContext?.activePolicy?.sandboxMode
      ?? stringOption(input.options?.['sandboxMode']) as 'read-only' | 'workspace-write' | 'full-access' | undefined
      ?? this.config.sandboxMode
      ?? 'read-only'
  }

  private resolveApprovalMode(input: AgentInput): 'plan' | 'auto_edit' | 'yolo' {
    const sandbox = this.resolveSandbox(input)
    if (sandbox === 'full-access') return 'yolo'
    if (sandbox === 'workspace-write') return 'auto_edit'
    return 'plan'
  }

  private async buildBaseProfileInputs(): Promise<Record<string, { sourcePath: string; targetPath: string }>> {
    const root = this.geminiConfig.cliBaseProfileRoot
    if (!root) return {}
    const files = this.geminiConfig.cliBaseProfileFiles ?? ['settings.json', 'projects.json', 'installation_id']
    const inputs: Record<string, { sourcePath: string; targetPath: string }> = {}
    for (const [index, relativePath] of files.entries()) {
      if (!relativePath || relativePath.startsWith('/') || relativePath.split(/[\\/]/u).includes('..')) {
        throw new Error(`Gemini base-profile file must be a contained relative path: ${relativePath}`)
      }
      const sourcePath = join(root, relativePath)
      const info = await stat(sourcePath).catch(() => null)
      if (!info) continue
      if (!info.isFile()) throw new Error(`Gemini base-profile input must be a regular file: ${sourcePath}`)
      inputs[`baseProfile${index}`] = { sourcePath, targetPath: `.gemini/${relativePath}` }
    }
    return inputs
  }
}

export function createGeminiCliAdapter(config: GeminiCliAdapterConfig = {}): GeminiCLIAdapter {
  return new GeminiCLIAdapter(config)
}

function policyRejected(message: string, reason: string): ForgeError {
  return new ForgeError({
    code: 'CAPABILITY_DENIED',
    message,
    recoverable: false,
    context: { providerId: 'gemini', backend: 'cli', reason, telemetry: 'gemini_cli_policy_rejected' },
  })
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readMcpDescriptors(input: AgentInput): readonly unknown[] {
  const value = input.options?.['mcpServers']
  return Array.isArray(value) ? value : []
}
