/**
 * Goose CLI host adapter grounded in the v1.7.0 `goose run` contract.
 *
 * Goose v1.7.0 emits terminal text in quiet mode. It has no JSONL stream and
 * no CLI sandbox flag, so this adapter isolates all Goose state and refuses
 * policies whose filesystem effect Goose cannot enforce.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ForgeError } from '@dzupagent/core/events'
import type { McpServerDescriptor } from '@dzupagent/runtime-contracts'
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

const PROVIDER_ID: AdapterProviderId = 'goose'
const GOOSE_BINARY = 'goose'
const CREDENTIAL_ENV = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)(?:_|$)/u
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const BUILTIN_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u

export interface GooseCliAdapterConfig extends AdapterConfig {
  /** Defaults to `goose`; injectable for managed installations and tests. */
  cliPath?: string | undefined
  /** Explicit model-provider identity, separate from the Goose agent host. */
  cliProvider?: string | undefined
  /** Approved Goose profile root used only for flat provider settings and recipes. */
  cliBaseProfileRoot?: string | undefined
  /** Defaults to config.yaml below cliBaseProfileRoot. */
  cliBaseProfileFile?: string | undefined
  /** Optional flat secrets file below cliBaseProfileRoot. Defaults to secrets.yaml. */
  cliBaseSecretsFile?: string | undefined
  /** Exact provider-specific environment keys permitted into the isolated run. */
  cliProviderProfileKeys?: readonly string[] | undefined
  /** Approved root for exact provider-host credential files copied into private HOME. */
  cliProviderAuthRoot?: string | undefined
  /** Exact relative credential files copied below the private HOME. */
  cliProviderAuthFiles?: readonly string[] | undefined
  /** Optional bounded-output overrides for deterministic harness tests. */
  runtimeLimits?: Partial<CliRuntimeLimits> | undefined
}

type FlatProfile = Readonly<Record<string, string>>

export class GooseAdapter extends BaseCliAdapter {
  private gooseConfig: GooseCliAdapterConfig

  constructor(config: GooseCliAdapterConfig = {}) {
    super(PROVIDER_ID, config)
    this.gooseConfig = { ...config }
  }

  configure(opts: Partial<AdapterConfig>): void {
    super.configure(opts)
    this.gooseConfig = { ...this.gooseConfig, ...opts }
  }

  protected getBinaryName(): string {
    return this.gooseConfig.cliPath ?? GOOSE_BINARY
  }

  protected async assertReady(input?: AgentInput): Promise<void> {
    await super.assertReady(input)
    const binary = this.getBinaryName()
    if (!await isBinaryAvailable(binary)) {
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message: `'${binary}' binary not found in PATH`,
        recoverable: false,
        suggestion: 'Install Goose 1.7.0 and configure an explicit model provider',
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
      nativeToolControls: { mode: false, allowlist: false, blocklist: false },
    }
  }

  protected buildArgs(input: AgentInput): string[] {
    this.validateSupportedInput(input)
    const provider = stringValue(input.options?.['gooseProvider']) ?? this.gooseConfig.cliProvider
    const model = this.config.model
    if (!provider) throw denied('Goose model-provider identity must be explicit', 'provider_identity')
    if (!model) throw denied('Goose model identity must be explicit', 'model_identity')

    const args = ['run', '--quiet', '--no-session', '--provider', provider, '--model', model]
    if (input.systemPrompt) args.push('--system', input.systemPrompt)
    if (input.maxTurns !== undefined) args.push('--max-turns', String(input.maxTurns))
    return args
  }

  protected override async prepareCliRun(input: AgentInput): Promise<PreparedCliRun> {
    this.validateSupportedInput(input)
    const cwd = resolve(input.workingDirectory ?? this.config.workingDirectory ?? process.cwd())
    await assertNoProjectGooseConfig(cwd)
    const baseProfile = await this.readBaseProfile()
    const provider = stringValue(input.options?.['gooseProvider'])
      ?? this.gooseConfig.cliProvider
      ?? baseProfile.config['GOOSE_PROVIDER']
    const model = this.config.model ?? baseProfile.config['GOOSE_MODEL']
    if (!provider) throw denied('Goose model-provider identity must be explicit', 'provider_identity')
    if (!model) throw denied('Goose model identity must be explicit', 'model_identity')

    const selectedCredentials = selectProviderCredentials(
      baseProfile,
      this.gooseConfig.cliProviderProfileKeys ?? [],
      this.gooseConfig.env,
    )
    const recipe = await this.readRecipe(input)
    const authProjection = await this.resolveProviderAuthProjection()
    const generatedFiles: Record<string, { path: string; content: string }> = {
      config: {
        path: 'config/goose/config.yaml',
        content: renderGooseConfig(provider, model),
      },
      secrets: { path: 'config/goose/secrets.yaml', content: '{}\n' },
      ...(recipe ? { recipe: { path: `config/goose/recipes/${recipe.name}`, content: recipe.content } } : {}),
    }
    const projection = await createCliHomeProjection({
      prefix: 'dzupagent-goose-',
      requiredDirectories: [
        'home', 'config/goose', 'config/goose/recipes', 'data/goose',
        'data/goose/sessions', 'cache/goose', 'state', 'logs',
      ],
      generatedFiles,
      approvedBaseProfileRoots: authProjection.root ? [authProjection.root] : [],
      baseProfileInputs: authProjection.files,
    })

    try {
      const env = this.buildIsolatedEnv(input, projection.root, selectedCredentials)
      const args = ['run', '--quiet', '--no-session', '--provider', provider, '--model', model]
      if (input.systemPrompt) args.push('--system', input.systemPrompt)
      if (input.maxTurns !== undefined) args.push('--max-turns', String(input.maxTurns))
      if (recipe) args.push('--recipe', join(projection.root, `config/goose/recipes/${recipe.name}`))
      args.push(...buildExtensionArgs(input))
      args.push('--text', input.prompt)
      return {
        args,
        cwd,
        env,
        stdoutMode: 'text',
        limits: this.gooseConfig.runtimeLimits,
        cleanup: () => projection.cleanup(),
      }
    } catch (error) {
      await projection.cleanup().catch(() => undefined)
      throw error
    }
  }

  protected mapProviderEvent(record: Record<string, unknown>, sessionId: string): AgentEvent | undefined {
    if (record['type'] !== 'text_result') return undefined
    return {
      type: 'adapter:completed',
      providerId: PROVIDER_ID,
      sessionId,
      result: typeof record['content'] === 'string' ? record['content'] : '',
      durationMs: typeof record['duration_ms'] === 'number' ? record['duration_ms'] : 0,
      timestamp: Date.now(),
    }
  }

  async *resumeSession(_sessionId: string, _input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    throw denied('Private disposable Goose runs do not support cross-run session resume', 'resume')
  }

  private validateSupportedInput(input: AgentInput): void {
    const sandbox = resolveSandbox(input, this.config)
    const policy = input.policyContext?.activePolicy
    if (this.config.apiKey) throw denied('Goose provider credentials require explicit provider-profile keys', 'generic_api_key')
    if (input.outputSchema) throw denied('Goose run v1.7.0 does not expose structured terminal output', 'structured_output')
    if (input.maxBudgetUsd !== undefined || policy?.maxBudgetUsd !== undefined) throw denied('Goose run v1.7.0 does not expose a deterministic budget limit', 'budget')
    if (input.resumeSessionId) throw denied('Private disposable Goose runs do not support cross-run session resume', 'resume')
    if (input.options?.['permissionMode'] !== undefined) throw denied('Goose run v1.7.0 has no permission-mode flag', 'permission_mode')
    if (input.options?.['gooseMode'] !== undefined && input.options['gooseMode'] !== 'auto') throw denied('Headless Goose cannot satisfy an interactive approval mode', 'approval_mode')
    if (sandbox !== 'full-access') throw denied(`Goose v1.7.0 cannot enforce ${sandbox} filesystem effects`, 'sandbox')
    if (policy?.approvalRequired !== false) throw denied('Goose full-access execution requires approvalRequired=false', 'approval')
    if (policy?.networkAccess === false) throw denied('Goose v1.7.0 cannot deterministically deny network access', 'network')
    if ((policy?.allowedTools?.length ?? 0) > 0 || (policy?.blockedTools?.length ?? 0) > 0) {
      throw denied('Goose v1.7.0 cannot enforce per-tool allowlists or blocklists', 'tool_policy')
    }
    validateExtensionInput(input)
  }

  private async readBaseProfile(): Promise<{ config: FlatProfile; secrets: FlatProfile }> {
    const root = this.gooseConfig.cliBaseProfileRoot
    if (!root) return { config: {}, secrets: {} }
    if (!isAbsolute(root)) throw denied('Goose base profile root must be absolute', 'profile_root')
    const config = await readContainedFlatProfile(root, this.gooseConfig.cliBaseProfileFile ?? 'config.yaml', true)
    const secrets = await readContainedFlatProfile(root, this.gooseConfig.cliBaseSecretsFile ?? 'secrets.yaml', false)
    return { config, secrets }
  }

  private async readRecipe(input: AgentInput): Promise<{ name: string; content: string } | undefined> {
    const value = stringValue(input.options?.['recipe'])
    if (!value) return undefined
    const root = this.gooseConfig.cliBaseProfileRoot
    if (!root) throw denied('Goose recipes require an approved base profile root', 'recipe_root')
    if (isAbsolute(value) || value.split(/[\\/]/u).includes('..')) throw denied('Goose recipe must be a contained relative path', 'recipe_path')
    const recipePath = join(root, value)
    const [approvedRoot, resolvedPath] = await Promise.all([realpath(root), realpath(recipePath).catch(() => '')])
    const fromRoot = resolvedPath ? relative(approvedRoot, resolvedPath) : '..'
    if (!resolvedPath || fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw denied('Goose recipe escapes its approved root or is missing', 'recipe_escape')
    const info = await stat(resolvedPath)
    if (!info.isFile()) throw denied('Goose recipe must be a regular file', 'recipe_shape')
    const content = await readFile(resolvedPath, 'utf8')
    assertNoCommandSubstitution(content, 'recipe')
    return { name: value.replaceAll(/[\\/]/gu, '_'), content }
  }

  private buildIsolatedEnv(input: AgentInput, root: string, selected: FlatProfile): Record<string, string> {
    const env = { ...this.buildSpawnEnv(input) }
    for (const key of Object.keys(env)) {
      if (key.startsWith('GOOSE_') || key.startsWith('OPENAI_') || key.startsWith('ANTHROPIC_') ||
        key.startsWith('AWS_') || key.startsWith('AZURE_') || key.startsWith('GOOGLE_') ||
        key.startsWith('VERTEXAI_') || CREDENTIAL_ENV.test(key)) delete env[key]
    }
    Object.assign(env, selected)
    env['HOME'] = join(root, 'home')
    env['XDG_CONFIG_HOME'] = join(root, 'config')
    env['XDG_DATA_HOME'] = join(root, 'data')
    env['XDG_CACHE_HOME'] = join(root, 'cache')
    env['GOOSE_DISABLE_KEYRING'] = '1'
    env['GOOSE_TELEMETRY_ENABLED'] = 'false'
    env['DO_NOT_TRACK'] = '1'
    return env
  }

  private async resolveProviderAuthProjection(): Promise<{
    root?: string | undefined
    files: Record<string, { sourcePath: string; targetPath: string }>
  }> {
    const requested = this.gooseConfig.cliProviderAuthFiles ?? []
    if (requested.length === 0) return { files: {} }
    const root = this.gooseConfig.cliProviderAuthRoot
    if (!root || !isAbsolute(root)) throw denied('Goose provider auth files require an absolute approved root', 'auth_root')
    const approvedRoot = await realpath(root).catch(() => '')
    if (!approvedRoot) throw denied('Goose provider auth root is missing', 'auth_root')
    const files: Record<string, { sourcePath: string; targetPath: string }> = {}
    for (const [index, relativeFile] of requested.entries()) {
      if (!relativeFile || isAbsolute(relativeFile) || relativeFile.split(/[\\/]/u).includes('..')) throw denied('Goose provider auth file must be a contained relative path', 'auth_file')
      const sourcePath = join(root, relativeFile)
      const resolvedPath = await realpath(sourcePath).catch(() => '')
      const fromRoot = resolvedPath ? relative(approvedRoot, resolvedPath) : '..'
      if (!resolvedPath || fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw denied('Goose provider auth file escapes its approved root or is missing', 'auth_escape')
      const info = await stat(resolvedPath)
      if (!info.isFile()) throw denied('Goose provider auth input must be a regular file', 'auth_shape')
      files[`auth-${index}`] = { sourcePath, targetPath: `home/${relativeFile}` }
    }
    return { root, files }
  }
}

export function createGooseCliAdapter(config: GooseCliAdapterConfig = {}): GooseAdapter {
  return new GooseAdapter(config)
}

function renderGooseConfig(provider: string, model: string): string {
  return [
    `GOOSE_PROVIDER: ${JSON.stringify(provider)}`,
    `GOOSE_MODEL: ${JSON.stringify(model)}`,
    'GOOSE_MODE: auto',
    'extensions: {}',
    '',
  ].join('\n')
}

function selectProviderCredentials(
  profile: { config: FlatProfile; secrets: FlatProfile },
  keys: readonly string[],
  configuredEnv: Readonly<Record<string, string>> | undefined,
): FlatProfile {
  const selected: Record<string, string> = {}
  for (const key of keys) {
    if (!ENV_NAME.test(key) || key.startsWith('GOOSE_')) throw denied(`Invalid Goose provider-profile key: ${key}`, 'profile_key')
    const values = [configuredEnv?.[key], profile.secrets[key], profile.config[key]].filter((value): value is string => value !== undefined)
    if (new Set(values).size > 1) throw denied(`Ambiguous Goose credential values for ${key}`, 'profile_ambiguous')
    if (values[0] === undefined) throw denied(`Goose selected provider requires profile key ${key}`, 'profile_missing')
    selected[key] = values[0]
  }
  return selected
}

async function readContainedFlatProfile(root: string, relativeFile: string, required: boolean): Promise<FlatProfile> {
  if (!relativeFile || isAbsolute(relativeFile) || relativeFile.split(/[\\/]/u).includes('..')) throw denied('Goose base profile file must be a contained relative path', 'profile_file')
  const path = join(root, relativeFile)
  const info = await stat(path).catch(() => null)
  if (!info) {
    if (!required) return {}
    throw denied(`Goose base profile file is missing: ${path}`, 'profile_missing')
  }
  if (!info.isFile()) throw denied('Goose base profile input must be a regular file', 'profile_shape')
  const [approvedRoot, resolvedPath] = await Promise.all([realpath(root), realpath(path)])
  const fromRoot = relative(approvedRoot, resolvedPath)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw denied('Goose base profile file escapes its approved root', 'profile_escape')
  return parseFlatYaml(await readFile(resolvedPath, 'utf8'))
}

function parseFlatYaml(content: string): FlatProfile {
  assertNoCommandSubstitution(content, 'profile')
  const result: Record<string, string> = {}
  for (const line of content.split(/\r?\n/u)) {
    if (!line || /^\s*(?:#|$)/u.test(line) || /^\s/u.test(line)) continue
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(line)
    if (!match) throw denied('Goose base profile contains unsupported top-level YAML', 'profile_yaml')
    const raw = match[2]?.trim() ?? ''
    if (!raw || raw === '{}' || raw === '[]' || raw === 'null' || raw === '~') continue
    result[match[1]!] = parseYamlScalar(raw)
  }
  return result
}

function parseYamlScalar(raw: string): string {
  if (raw.startsWith('&') || raw.startsWith('*') || raw.startsWith('!') || raw.includes(' #')) throw denied('Goose base profile scalar uses unsupported YAML features', 'profile_yaml')
  if (raw.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(raw)
      if (typeof value === 'string') return value
    } catch { /* classified below */ }
    throw denied('Goose base profile contains an invalid quoted scalar', 'profile_yaml')
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'")
  if (/^[^{}\[\],]+$/u.test(raw)) return raw
  throw denied('Goose base profile contains a non-scalar selected value', 'profile_yaml')
}

function buildExtensionArgs(input: AgentInput): string[] {
  const args: string[] = []
  const refs = readReferenceValues(input)
  for (const descriptor of readMcpDescriptors(input)) {
    const transport = descriptor.transport
    if (transport.kind === 'stdio') {
      const env = resolveReferences(transport.envRefs, refs)
      const command = [
        ...Object.entries(env).map(([key, value]) => `${key}=${quoteCommandToken(value)}`),
        quoteCommandToken(transport.command),
        ...(transport.args ?? []).map(quoteCommandToken),
      ].join(' ')
      args.push('--with-extension', command)
    } else {
      const mode = input.options?.['gooseHttpTransport']
      if (mode === 'remote') args.push('--with-remote-extension', transport.url)
      else if (mode === 'streamable-http') args.push('--with-streamable-http-extension', transport.url)
      else throw denied(`Goose HTTP transport for ${descriptor.id} requires an explicit gooseHttpTransport`, 'mcp_transport')
    }
  }
  const builtins = stringArray(input.options?.['gooseBuiltins'])
  if (builtins.length > 0) args.push('--with-builtin', builtins.join(','))
  return args
}

function validateExtensionInput(input: AgentInput): void {
  for (const name of stringArray(input.options?.['gooseBuiltins'])) if (!BUILTIN_NAME.test(name)) throw denied(`Invalid Goose builtin extension name: ${name}`, 'extension_name')
  for (const descriptor of readMcpDescriptors(input)) {
    if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.transport) throw denied('Invalid Goose MCP descriptor', 'mcp_shape')
    if ((descriptor.enabledTools?.length ?? 0) > 0 || (descriptor.disabledTools?.length ?? 0) > 0) throw denied(`Goose cannot enforce per-tool controls for MCP server ${descriptor.id}`, 'mcp_tools')
    if (descriptor.transport.kind === 'stdio') {
      if (!descriptor.transport.command || descriptor.transport.command.includes('\0')) throw denied(`Invalid Goose stdio command for ${descriptor.id}`, 'mcp_command')
      if (descriptor.transport.workingDirectory) throw denied(`Goose cannot project a per-extension working directory for ${descriptor.id}`, 'mcp_cwd')
      resolveReferences(descriptor.transport.envRefs, readReferenceValues(input))
    } else {
      if (descriptor.transport.headerRefs && Object.keys(descriptor.transport.headerRefs).length > 0) throw denied(`Goose CLI cannot project HTTP headers for ${descriptor.id}`, 'mcp_headers')
      let url: URL
      try { url = new URL(descriptor.transport.url) } catch { throw denied(`Invalid Goose MCP URL for ${descriptor.id}`, 'mcp_url') }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw denied(`Unsupported Goose MCP URL protocol for ${descriptor.id}`, 'mcp_url')
    }
  }
}

function quoteCommandToken(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw denied('Goose extension command contains an invalid token', 'mcp_command')
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function resolveReferences(mapping: Readonly<Record<string, string>> | undefined, refs: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, reference] of Object.entries(mapping ?? {})) {
    if (!ENV_NAME.test(name)) throw denied(`Invalid Goose extension environment name: ${name}`, 'mcp_env')
    const value = refs[reference]
    if (value === undefined) throw denied(`Unresolved local MCP reference: ${reference}`, 'mcp_reference')
    result[name] = value
  }
  return result
}

async function assertNoProjectGooseConfig(cwd: string): Promise<void> {
  for (const name of ['.goosehints', '.goose']) {
    const path = join(cwd, name)
    if (await stat(path).then(() => true).catch(() => false)) throw denied(`Goose project configuration cannot enter an isolated run: ${path}`, 'project_config')
  }
}

function assertNoCommandSubstitution(value: string, source: string): void {
  if (value.includes('$(') || value.includes('`')) throw denied(`Goose ${source} contains executable command substitution`, 'profile_command')
}

function resolveSandbox(input: AgentInput, config: Pick<AdapterConfig, 'sandboxMode'>): 'read-only' | 'workspace-write' | 'full-access' {
  const mode = input.policyContext?.activePolicy?.sandboxMode ?? stringValue(input.options?.['sandboxMode']) ?? config.sandboxMode ?? 'read-only'
  if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'full-access') throw denied(`Unsupported Goose sandbox mode: ${mode}`, 'sandbox')
  return mode
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function denied(message: string, reason: string): ForgeError {
  return new ForgeError({
    code: 'CAPABILITY_DENIED',
    message,
    recoverable: false,
    context: { providerId: PROVIDER_ID, backend: 'cli-host', reason },
  })
}
