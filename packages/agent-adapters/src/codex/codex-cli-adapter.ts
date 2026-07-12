import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ForgeError } from '@dzupagent/core/events'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
  HealthStatus,
  RawAgentEvent,
  SessionInfo,
} from '../types.js'
import { getDefaultMonitorStatus } from '../provider-catalog.js'
import { normalizeCodex } from '../normalize-codex.js'
import { createCliHomeProjection, runJsonlProcess } from '../cli-runtime/index.js'
import type { CliHomeProjection, CliRuntimeDependencies, CliRuntimeLimits } from '../cli-runtime/index.js'

const execFileAsync = promisify(execFile)

export interface CodexCliAdapterConfig extends AdapterConfig {
  /** Defaults to `codex`; injectable for managed installations and tests. */
  cliPath?: string | undefined
  /** Optional approved base Codex profile directory copied into the private CODEX_HOME. */
  cliBaseProfileRoot?: string | undefined
  /** Relative regular files copied from cliBaseProfileRoot. */
  cliBaseProfileFiles?: readonly string[] | undefined
  /** Strict JSONL is the canonical Codex CLI backend default. */
  malformedLinePolicy?: 'skip' | 'error' | undefined
  /** Test/runtime injection point; not forwarded to the subprocess. */
  runtimeDependencies?: CliRuntimeDependencies | undefined
  /** Optional bounded-output overrides for deterministic harness tests. */
  runtimeLimits?: Partial<CliRuntimeLimits> | undefined
}

interface PreparedCodexCliRun {
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly env: Readonly<Record<string, string>>
  readonly homeProjection: CliHomeProjection
}

export class CodexCliAdapter implements AgentCLIAdapter {
  readonly providerId = 'codex' as const
  private config: CodexCliAdapterConfig
  private readonly runtimeDependencies: CliRuntimeDependencies
  private readonly abortControllers = new Set<AbortController>()

  constructor(config: CodexCliAdapterConfig = {}) {
    this.runtimeDependencies = config.runtimeDependencies ?? {}
    this.config = { ...config, runtimeDependencies: undefined }
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
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

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.executeWithRaw(input)) {
      if (event.type !== 'adapter:provider_raw') yield event
    }
  }

  async *executeWithRaw(input: AgentInput): AsyncGenerator<AgentStreamEvent, void, undefined> {
    const sessionId = randomUUID()
    const startedAt = Date.now()
    const controller = new AbortController()
    this.abortControllers.add(controller)
    const signal = combineSignals(input.signal, controller.signal)

    yield this.withCorrelation({
      type: 'adapter:started',
      providerId: 'codex',
      sessionId,
      timestamp: Date.now(),
      prompt: input.prompt,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      model: this.resolveModel(input),
      workingDirectory: input.workingDirectory ?? this.config.workingDirectory,
      ...({ backend: 'cli', telemetry: { codex_backend_selected: 'cli' } } as Record<string, unknown>),
    } as AgentEvent, input)

    try {
      const prepared = await this.prepareCliRun(input)
      let ordinal = 0
      let completed = false
      let failed = false
      let lastAssistantResult = ''
      for await (const record of runJsonlProcess({
        command: this.config.cliPath ?? 'codex',
        args: prepared.args,
        cwd: prepared.cwd,
        env: prepared.env,
        homeProjection: prepared.homeProjection,
        signal,
        timeoutMs: this.config.timeoutMs,
        limits: this.config.runtimeLimits,
        malformedLinePolicy: this.config.malformedLinePolicy ?? 'error',
      }, this.runtimeDependencies)) {
        ordinal += 1
        const raw = this.wrapRaw(record, sessionId, input, ordinal)
        yield raw
        const mapped = this.mapProviderEvent(record, sessionId, input)
        if (!mapped) continue
        const mappedEvents = Array.isArray(mapped) ? mapped : [mapped]
        for (const candidate of mappedEvents) {
          if (candidate.type === 'adapter:message' && candidate.role === 'assistant') {
            lastAssistantResult = candidate.content
          }
          const event = candidate.type === 'adapter:completed' && !candidate.result && lastAssistantResult
            ? { ...candidate, result: lastAssistantResult }
            : candidate
          if (event.type === 'adapter:completed') completed = true
          if (event.type === 'adapter:failed') failed = true
          yield this.withCorrelation(event, input)
        }
      }
      if (!completed && !failed) {
        yield this.withCorrelation({
          type: 'adapter:completed',
          providerId: 'codex',
          sessionId,
          result: '',
          durationMs: Date.now() - startedAt,
          timestamp: Date.now(),
        }, input)
      }
    } catch (error) {
      const failed = this.toFailedEvent(error, sessionId, input)
      yield failed
      throw error
    } finally {
      this.abortControllers.delete(controller)
    }
  }

  async *resumeSession(sessionId: string, input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.execute({ ...input, resumeSessionId: sessionId })) yield event
  }

  interrupt(): void {
    for (const controller of this.abortControllers) controller.abort()
    this.abortControllers.clear()
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await execFileAsync(this.config.cliPath ?? 'codex', ['--version'], { timeout: 5_000 })
      return {
        healthy: true,
        providerId: 'codex',
        sdkInstalled: false,
        cliAvailable: true,
        lastSuccessTimestamp: Date.now(),
        monitorStatus: getDefaultMonitorStatus('codex'),
      }
    } catch {
      return {
        healthy: false,
        providerId: 'codex',
        sdkInstalled: false,
        cliAvailable: false,
        lastError: 'Codex CLI binary not found or not executable',
        monitorStatus: getDefaultMonitorStatus('codex'),
      }
    }
  }

  async listSessions(): Promise<SessionInfo[]> { return [] }
  async forkSession(): Promise<string> { throw unsupported('Codex CLI session forking is not exposed by this backend') }

  buildArgs(input: AgentInput, outputSchemaPath?: string): string[] {
    this.validateSupportedPolicy(input)
    const args = [
      '--ask-for-approval', this.resolveApprovalPolicy(input),
      '--sandbox', this.resolveSandbox(input),
      '--model', this.resolveModel(input),
    ]
    const reasoning = this.resolveReasoning(input)
    if (reasoning) args.push('--config', `model_reasoning_effort="${reasoning}"`)
    args.push('exec')
    if (input.resumeSessionId) args.push('resume')
    args.push('--json')
    if (outputSchemaPath) args.push('--output-schema', outputSchemaPath)
    args.push('--')
    if (input.resumeSessionId) args.push(input.resumeSessionId)
    args.push(input.prompt)
    return args
  }

  async prepareCliRun(input: AgentInput): Promise<PreparedCodexCliRun> {
    this.validateSupportedPolicy(input)
    const cwd = input.workingDirectory ?? this.config.workingDirectory
    if (this.resolveSandbox(input) === 'workspace-write' && !cwd) {
      throw policyRejected('Codex CLI workspace-write requires an explicit working directory', 'missing_working_directory')
    }
    const outputSchema = input.outputSchema === undefined ? undefined : JSON.stringify(input.outputSchema)
    const baseProfileInputs = await this.buildBaseProfileInputs()
    const homeProjection = await createCliHomeProjection({
      prefix: 'dzupagent-codex-',
      envVar: 'CODEX_HOME',
      requiredDirectories: ['sessions', 'mcp'],
      approvedBaseProfileRoots: this.config.cliBaseProfileRoot ? [this.config.cliBaseProfileRoot] : [],
      baseProfileInputs,
      generatedFiles: outputSchema === undefined ? undefined : {
        outputSchema: { path: 'output-schema.json', content: `${outputSchema}\n` },
      },
    })
    try {
      return {
        args: this.buildArgs(input, homeProjection.generatedPaths['outputSchema']),
        cwd,
        env: this.buildSpawnEnv(),
        homeProjection,
      }
    } catch (error) {
      await homeProjection.cleanup().catch(() => undefined)
      throw error
    }
  }

  mapProviderEvent(record: Record<string, unknown>, sessionId: string, input: AgentInput): AgentEvent | AgentEvent[] | null {
    const normalized = normalizeCodex(record, sessionId)
    if (normalized?.type === 'adapter:failed') {
      const text = `${normalized.error} ${normalized.code ?? ''}`.toLowerCase()
      if (text.includes('auth') || text.includes('login')) {
        return {
          ...normalized,
          code: 'ADAPTER_AUTH_FAILED',
          ...({ telemetry: { codex_cli_auth_failure: true } } as Record<string, unknown>),
        }
      }
    }
    return normalized ? this.withCorrelation(normalized, input) : null
  }

  private validateSupportedPolicy(input: AgentInput): void {
    const sandbox = this.resolveSandbox(input)
    if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
      throw policyRejected(`Codex CLI backend does not support sandbox mode: ${sandbox}`, 'unsupported_sandbox')
    }
    const approval = this.resolveApprovalPolicy(input)
    if (!['never', 'on-request', 'untrusted'].includes(approval)) {
      throw policyRejected(`Codex CLI backend does not support approval policy: ${approval}`, 'unsupported_approval')
    }
    if (input.maxTurns !== undefined || input.policyContext?.activePolicy?.maxTurns !== undefined) {
      throw policyRejected('Codex CLI backend does not expose a deterministic max-turns flag', 'unsupported_max_turns')
    }
    const activePolicy = input.policyContext?.activePolicy
    if (activePolicy?.allowedTools?.length) {
      throw policyRejected('Codex CLI backend does not strictly enforce tool allowlists', 'unsupported_tool_allowlist')
    }
    if (readMcpDescriptors(input).length > 0) {
      throw policyRejected('Codex CLI backend does not accept MCP descriptors through this adapter contract', 'unsupported_mcp')
    }
  }

  private resolveModel(input: AgentInput): string {
    return stringOption(input.options?.['model']) ?? this.config.model ?? 'gpt-5.5'
  }

  private resolveReasoning(input: AgentInput): 'low' | 'medium' | 'high' | undefined {
    const value = stringOption(input.options?.['reasoning']) ?? this.config.reasoning
    return value === 'low' || value === 'medium' || value === 'high' ? value : undefined
  }

  private resolveSandbox(input: AgentInput): string {
    return input.policyContext?.activePolicy?.sandboxMode
      ?? stringOption(input.options?.['sandboxMode'])
      ?? this.config.sandboxMode
      ?? 'read-only'
  }

  private resolveApprovalPolicy(input: AgentInput): string {
    const explicit = stringOption(input.options?.['approvalPolicy'])
    if (explicit) return explicit
    const configPolicy = stringOption((this.config as AdapterConfig & { approvalPolicy?: unknown }).approvalPolicy)
    if (configPolicy) return configPolicy
    const required = input.policyContext?.activePolicy?.approvalRequired
    return required === false ? 'never' : 'on-request'
  }

  private buildSpawnEnv(): Readonly<Record<string, string>> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !isSensitiveEnvKey(key)) env[key] = value
    }
    for (const [key, value] of Object.entries(this.config.env ?? {})) {
      if (!isSensitiveEnvKey(key)) env[key] = value
    }
    return env
  }

  private async buildBaseProfileInputs(): Promise<Record<string, { sourcePath: string; targetPath: string }>> {
    const root = this.config.cliBaseProfileRoot
    if (!root) return {}
    const files = this.config.cliBaseProfileFiles ?? ['auth.json', 'config.toml', 'installation_id', 'version.json']
    const inputs: Record<string, { sourcePath: string; targetPath: string }> = {}
    for (const [index, relativePath] of files.entries()) {
      if (!relativePath || relativePath.startsWith('/') || relativePath.split(/[\\/]/u).includes('..')) {
        throw new Error(`Codex base-profile file must be a contained relative path: ${relativePath}`)
      }
      const sourcePath = join(root, relativePath)
      const info = await stat(sourcePath).catch(() => null)
      if (!info) continue
      if (!info.isFile()) throw new Error(`Codex base-profile input must be a regular file: ${sourcePath}`)
      inputs[`baseProfile${index}`] = { sourcePath, targetPath: relativePath }
    }
    return inputs
  }

  private wrapRaw(record: Record<string, unknown>, sessionId: string, input: AgentInput, ordinal: number): AgentStreamEvent {
    const rawEvent: RawAgentEvent = {
      providerId: 'codex',
      runId: input.correlationId ?? sessionId,
      sessionId,
      providerEventId: `codex-cli:${sessionId}:${ordinal}`,
      timestamp: Date.now(),
      source: 'stdout',
      payload: record,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    }
    return { type: 'adapter:provider_raw', rawEvent }
  }

  private toFailedEvent(error: unknown, sessionId: string, input: AgentInput): AgentEvent {
    const message = error instanceof Error ? error.message : String(error)
    const code = ForgeError.is(error) ? error.code : undefined
    const authFailure = `${message} ${code ?? ''}`.toLowerCase().match(/auth|login/) !== null
    return this.withCorrelation({
      type: 'adapter:failed',
      providerId: 'codex',
      sessionId,
      error: message,
      code: authFailure ? 'ADAPTER_AUTH_FAILED' : code,
      timestamp: Date.now(),
      ...(authFailure ? ({ telemetry: { codex_cli_auth_failure: true } } as Record<string, unknown>) : {}),
    }, input)
  }

  private withCorrelation<T extends AgentStreamEvent>(event: T, input: AgentInput): T {
    if (!input.correlationId || event.type === 'adapter:provider_raw' || 'correlationId' in event) return event
    return { ...event, correlationId: input.correlationId } as T
  }
}

export function createCodexCliAdapter(config: CodexCliAdapterConfig = {}): CodexCliAdapter {
  return new CodexCliAdapter(config)
}

function combineSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (!external) return internal
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (external.aborted || internal.aborted) controller.abort()
  else {
    external.addEventListener('abort', abort, { once: true })
    internal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

function policyRejected(message: string, reason: string): ForgeError {
  return new ForgeError({
    code: 'CAPABILITY_DENIED',
    message,
    recoverable: false,
    context: { providerId: 'codex', backend: 'cli', reason, telemetry: 'codex_cli_policy_rejected' },
  })
}

function unsupported(message: string): ForgeError {
  return new ForgeError({ code: 'CAPABILITY_DENIED', message, recoverable: false, context: { providerId: 'codex', backend: 'cli' } })
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readMcpDescriptors(input: AgentInput): readonly unknown[] {
  const value = input.options?.['mcpServers']
  return Array.isArray(value) ? value : []
}

function isSensitiveEnvKey(key: string): boolean {
  return /(?:api[_-]?key|token|secret|credential|password|auth)/iu.test(key)
}
