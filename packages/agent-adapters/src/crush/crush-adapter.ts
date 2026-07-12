/**
 * Crush CLI host adapter grounded in the v0.51.2 `crush run` contract.
 *
 * Crush emits plain assistant text in non-interactive mode and automatically
 * approves every remaining tool. This adapter therefore projects a sanitized,
 * private provider profile and enforces policy by disabling tools before spawn.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { ForgeError } from '@dzupagent/core/events'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AdapterProviderId,
  AgentEvent,
  AgentInput,
} from '../types.js'
import { BaseCliAdapter, type PreparedCliRun } from '../base/base-cli-adapter.js'
import { createCliHomeProjection } from '../cli-runtime/index.js'
import type { CliRuntimeLimits } from '../cli-runtime/index.js'
import { isBinaryAvailable } from '../utils/process-helpers.js'
import { mapCliProviderEvent } from '../utils/provider-event-normalization.js'

const PROVIDER_ID: AdapterProviderId = 'crush'
const CRUSH_BINARY = 'crush'
const ALL_TOOLS = [
  'agent', 'bash', 'job_output', 'job_kill', 'download', 'edit', 'multiedit',
  'lsp_diagnostics', 'lsp_references', 'lsp_restart', 'fetch', 'agentic_fetch',
  'glob', 'grep', 'ls', 'sourcegraph', 'todos', 'view', 'write',
  'list_mcp_resources', 'read_mcp_resource',
] as const
const READ_ONLY_TOOLS = ['glob', 'grep', 'ls', 'lsp_diagnostics', 'lsp_references', 'view'] as const
const WORKSPACE_WRITE_TOOLS = [...READ_ONLY_TOOLS, 'edit', 'multiedit', 'todos', 'write'] as const
const CREDENTIAL_ENV = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)(?:_|$)/u

export interface CrushCliAdapterConfig extends AdapterConfig {
  /** Defaults to `crush`; injectable for managed installations and tests. */
  cliPath?: string | undefined
  /** Approved profile root containing Crush's global data `crush.json`. */
  cliBaseProfileRoot?: string | undefined
  /** Defaults to `crush.json` below cliBaseProfileRoot. */
  cliBaseProfileFile?: string | undefined
  /** Optional bounded-output overrides for deterministic harness tests. */
  runtimeLimits?: Partial<CliRuntimeLimits> | undefined
}

type JsonObject = Record<string, unknown>

export class CrushAdapter extends BaseCliAdapter {
  private crushConfig: CrushCliAdapterConfig

  constructor(config: CrushCliAdapterConfig = {}) {
    super(PROVIDER_ID, config)
    this.crushConfig = { ...config }
  }

  configure(opts: Partial<AdapterConfig>): void {
    super.configure(opts)
    this.crushConfig = { ...this.crushConfig, ...opts }
  }

  protected getBinaryName(): string {
    return this.crushConfig.cliPath ?? CRUSH_BINARY
  }

  protected async assertReady(input?: AgentInput): Promise<void> {
    await super.assertReady(input)
    const binary = this.getBinaryName()
    if (!await isBinaryAvailable(binary)) {
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message: `'${binary}' binary not found in PATH`,
        recoverable: false,
        suggestion: 'Install Crush and configure an explicit local base profile for the selected model provider',
        context: { command: binary, providerId: PROVIDER_ID, backend: 'cli-host' },
      })
    }
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: false,
      supportsCostUsage: false,
      nativeToolControls: { mode: true, allowlist: true, blocklist: true },
    }
  }

  protected buildArgs(input: AgentInput): string[] {
    this.validateSupportedInput(input)
    const args = ['run', '--quiet']
    if (this.config.model) args.push('--model', this.config.model)
    args.push('--', input.prompt)
    return args
  }

  protected override async prepareCliRun(input: AgentInput): Promise<PreparedCliRun> {
    this.validateSupportedInput(input)
    const cwd = resolve(input.workingDirectory ?? this.config.workingDirectory ?? process.cwd())
    await assertNoProjectCrushConfig(cwd)
    const baseProfile = await this.readBaseProfile()
    const policyProfile = buildPolicyProfile(baseProfile, input, this.config)
    const projection = await createCliHomeProjection({
      prefix: 'dzupagent-crush-',
      requiredDirectories: ['config', 'data', 'run-data', 'home', 'skills', 'xdg-cache'],
      generatedFiles: {
        config: { path: 'config/crush.json', content: `${JSON.stringify(policyProfile.config)}\n` },
        data: { path: 'data/crush.json', content: `${JSON.stringify(policyProfile.config)}\n` },
      },
    })

    try {
      const env = this.buildIsolatedEnv(input, projection.root, policyProfile.requiredEnv)
      const args = [
        '--cwd', cwd,
        '--data-dir', join(projection.root, 'run-data'),
        ...this.buildArgs(input),
      ]
      return {
        args,
        cwd,
        env,
        stdoutMode: 'text',
        limits: this.crushConfig.runtimeLimits,
        cleanup: () => projection.cleanup(),
      }
    } catch (error) {
      await projection.cleanup().catch(() => undefined)
      throw error
    }
  }

  protected mapProviderEvent(record: Record<string, unknown>, sessionId: string): AgentEvent | undefined {
    if (record['type'] === 'text_result') {
      return {
        type: 'adapter:completed',
        providerId: PROVIDER_ID,
        sessionId,
        result: typeof record['content'] === 'string' ? record['content'] : '',
        durationMs: typeof record['duration_ms'] === 'number' ? record['duration_ms'] : 0,
        timestamp: Date.now(),
      }
    }
    return mapCliProviderEvent(record, sessionId, {
      providerId: PROVIDER_ID,
      defaultErrorMessage: 'Unknown Crush CLI error',
    })
  }

  async *resumeSession(_sessionId: string, _input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    throw new ForgeError({
      code: 'CAPABILITY_DENIED',
      message: 'Private disposable Crush data directories cannot provide durable cross-run session resume',
      recoverable: false,
      context: { providerId: PROVIDER_ID, capability: 'resume' },
    })
  }

  private validateSupportedInput(input: AgentInput): void {
    const sandbox = resolveSandbox(input, this.config)
    const policy = input.policyContext?.activePolicy
    if (this.config.apiKey) throw denied('Crush provider credentials must come from an explicit base profile', 'generic_api_key')
    if (input.systemPrompt) throw denied('Crush run v0.51.2 does not expose a system-prompt flag', 'system_prompt')
    if (input.outputSchema) throw denied('Crush run v0.51.2 does not expose structured output', 'structured_output')
    if (input.maxTurns !== undefined) throw denied('Crush run v0.51.2 does not expose a deterministic turn limit', 'max_turns')
    if (input.maxBudgetUsd !== undefined || policy?.maxBudgetUsd !== undefined) throw denied('Crush run v0.51.2 does not expose a deterministic budget limit', 'budget')
    if (input.resumeSessionId) throw denied('Private disposable Crush runs do not support cross-run session resume', 'resume')
    if (readMcpDescriptors(input).length > 0) throw denied('Crush MCP tools cannot be safely auto-approved in non-interactive mode', 'mcp')
    if (sandbox !== 'read-only' && policy?.approvalRequired !== false) {
      throw denied('Crush non-interactive write access requires approvalRequired=false because remaining tools are auto-approved', 'approval')
    }
    if (sandbox === 'full-access' && policy?.networkAccess === false) {
      throw denied('Crush full-access cannot deterministically deny network access while bash is enabled', 'network')
    }
  }

  private async readBaseProfile(): Promise<JsonObject> {
    const root = this.crushConfig.cliBaseProfileRoot
    if (!root) return {}
    if (!isAbsolute(root)) throw denied('Crush base profile root must be absolute', 'profile_root')
    const relativeFile = this.crushConfig.cliBaseProfileFile ?? 'crush.json'
    if (!relativeFile || isAbsolute(relativeFile) || relativeFile.split(/[\\/]/u).includes('..')) {
      throw denied('Crush base profile file must be a contained relative path', 'profile_file')
    }
    const path = join(root, relativeFile)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw denied(`Crush base profile file is missing: ${path}`, 'profile_missing')
    const [approvedRoot, resolvedPath] = await Promise.all([realpath(root), realpath(path)])
    const fromRoot = relative(approvedRoot, resolvedPath)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw denied('Crush base profile file escapes its approved root', 'profile_escape')
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      throw denied('Crush base profile must be valid JSON', 'profile_json')
    }
    if (!isObject(parsed)) throw denied('Crush base profile must be a JSON object', 'profile_shape')
    assertNoCommandSubstitution(parsed)
    return parsed
  }

  private buildIsolatedEnv(input: AgentInput, root: string, requiredEnv: readonly string[]): Record<string, string> {
    const source = this.buildSpawnEnv(input)
    const env: Record<string, string> = { ...source }
    for (const key of Object.keys(env)) {
      if (key.startsWith('CRUSH_') || key.startsWith('AWS_') || key.startsWith('AZURE_') ||
        key.startsWith('GOOGLE_') || key.startsWith('VERTEXAI_') || CREDENTIAL_ENV.test(key)) delete env[key]
    }
    for (const key of requiredEnv) {
      const value = this.crushConfig.env?.[key] ?? process.env[key]
      if (!value) throw denied(`Crush selected provider requires environment variable ${key}`, 'profile_env')
      env[key] = value
    }
    env['HOME'] = join(root, 'home')
    env['XDG_CONFIG_HOME'] = join(root, 'config')
    env['XDG_DATA_HOME'] = join(root, 'data')
    env['XDG_CACHE_HOME'] = join(root, 'xdg-cache')
    env['CRUSH_GLOBAL_CONFIG'] = join(root, 'config')
    env['CRUSH_GLOBAL_DATA'] = join(root, 'data')
    env['CRUSH_SKILLS_DIR'] = join(root, 'skills')
    env['CRUSH_DISABLE_PROVIDER_AUTO_UPDATE'] = '1'
    env['CRUSH_DISABLE_METRICS'] = '1'
    env['DO_NOT_TRACK'] = '1'
    return env
  }
}

export function createCrushCliAdapter(config: CrushCliAdapterConfig = {}): CrushAdapter {
  return new CrushAdapter(config)
}

function buildPolicyProfile(base: JsonObject, input: AgentInput, adapterConfig: AdapterConfig): { config: JsonObject; requiredEnv: string[] } {
  const baseModels = isObject(base['models']) ? base['models'] : {}
  const selected = resolveSelectedModel(baseModels, adapterConfig.model)
  const baseProviders = isObject(base['providers']) ? base['providers'] : {}
  const providerConfig = selected ? baseProviders[selected.provider] : undefined
  if (selected && !isObject(providerConfig)) throw denied(`Crush selected provider is absent from the base profile: ${selected.provider}`, 'provider_identity')
  const provider = isObject(providerConfig) ? structuredClone(providerConfig) : undefined
  const requiredEnv = provider ? [...collectEnvironmentReferences(provider)] : []
  const allowedTools = resolveAllowedTools(input, adapterConfig)
  const disabledTools = ALL_TOOLS.filter((tool) => !allowedTools.has(tool))
  const model = selected ? { model: selected.model, provider: selected.provider, ...(selected.source ?? {}) } : undefined
  if (model) {
    model.model = selected!.model
    model.provider = selected!.provider
  }
  const config: JsonObject = {
    ...(model ? { models: { large: model, small: model } } : {}),
    ...(selected && provider ? { providers: { [selected.provider]: provider } } : {}),
    permissions: { allowed_tools: [] },
    mcp: {},
    lsp: {},
    options: {
      disabled_tools: disabledTools,
      disable_provider_auto_update: true,
      disable_metrics: true,
      disable_notifications: true,
      auto_lsp: false,
      attribution: { trailer_style: 'none', generated_with: false },
    },
  }
  return { config, requiredEnv }
}

function resolveSelectedModel(models: JsonObject, configuredModel?: string): { provider: string; model: string; source?: JsonObject } | undefined {
  if (configuredModel) {
    const boundary = configuredModel.indexOf('/')
    if (boundary <= 0 || boundary === configuredModel.length - 1) {
      throw denied('Crush model selection must be provider/model to preserve provider identity', 'model_identity')
    }
    return { provider: configuredModel.slice(0, boundary), model: configuredModel.slice(boundary + 1) }
  }
  const large = isObject(models['large']) ? models['large'] : undefined
  const provider = stringValue(large?.['provider'])
  const model = stringValue(large?.['model'])
  return provider && model ? { provider, model, source: structuredClone(large) } : undefined
}

function resolveAllowedTools(input: AgentInput, adapterConfig: AdapterConfig): Set<string> {
  const sandbox = resolveSandbox(input, adapterConfig)
  const policy = input.policyContext?.activePolicy
  const baseline = sandbox === 'read-only'
    ? READ_ONLY_TOOLS
    : sandbox === 'workspace-write'
      ? WORKSPACE_WRITE_TOOLS
      : ALL_TOOLS
  const requested = policy?.allowedTools ?? stringArray(input.options?.['allowedTools'])
  const blocked = policy?.blockedTools ?? stringArray(input.options?.['blockedTools'])
  for (const tool of [...requested, ...blocked]) if (!ALL_TOOLS.includes(tool as typeof ALL_TOOLS[number])) throw denied(`Unknown Crush tool: ${tool}`, 'tool_name')
  if (requested.length > 0) {
    for (const tool of requested) if (!baseline.includes(tool as never)) throw denied(`Crush tool ${tool} exceeds ${sandbox} policy`, 'tool_scope')
  }
  const selected = new Set(requested.length > 0 ? requested : baseline)
  for (const tool of blocked) selected.delete(tool)
  if (policy?.networkAccess === false) {
    for (const tool of ['bash', 'download', 'fetch', 'agentic_fetch', 'sourcegraph']) selected.delete(tool)
  }
  return selected
}

async function assertNoProjectCrushConfig(cwd: string): Promise<void> {
  let cursor = cwd
  for (;;) {
    for (const name of ['crush.json', '.crush.json']) {
      if (await stat(join(cursor, name)).then((info) => info.isFile()).catch(() => false)) {
        throw denied(`Crush project config is executable trusted input and cannot enter an isolated run: ${join(cursor, name)}`, 'project_config')
      }
    }
    const parent = dirname(cursor)
    if (parent === cursor || cursor === parse(cursor).root) return
    cursor = parent
  }
}

function assertNoCommandSubstitution(value: unknown, path = 'profile'): void {
  if (typeof value === 'string' && value.includes('$(')) throw denied(`Crush ${path} contains executable command substitution`, 'profile_command')
  if (Array.isArray(value)) value.forEach((entry, index) => assertNoCommandSubstitution(entry, `${path}[${index}]`))
  else if (isObject(value)) for (const [key, entry] of Object.entries(value)) assertNoCommandSubstitution(entry, `${path}.${key}`)
}

function collectEnvironmentReferences(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu)) found.add(match[1] ?? match[2]!)
  } else if (Array.isArray(value)) value.forEach((entry) => collectEnvironmentReferences(entry, found))
  else if (isObject(value)) Object.values(value).forEach((entry) => collectEnvironmentReferences(entry, found))
  return found
}

function resolveSandbox(input: AgentInput, config: Pick<AdapterConfig, 'sandboxMode'>): 'read-only' | 'workspace-write' | 'full-access' {
  const mode = input.policyContext?.activePolicy?.sandboxMode
    ?? stringValue(input.options?.['sandboxMode'])
    ?? config.sandboxMode
    ?? 'read-only'
  if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'full-access') throw denied(`Unsupported Crush sandbox mode: ${mode}`, 'sandbox')
  return mode
}

function readMcpDescriptors(input: AgentInput): readonly unknown[] {
  const value = input.options?.['mcpServers']
  return Array.isArray(value) ? value : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function denied(message: string, reason: string): ForgeError {
  return new ForgeError({
    code: 'CAPABILITY_DENIED',
    message,
    recoverable: false,
    context: { providerId: PROVIDER_ID, reason },
  })
}
