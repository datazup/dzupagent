import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { ForgeError, type ForgeErrorCode } from '@dzupagent/core/events'
import type { AdapterConfig, AgentInput, InteractionPolicy } from '../types.js'
import type { PiCredentialStore, PiExtensionFactory, PiSdk, PiSession, PiSessionManager } from './pi-sdk-types.js'

const PI_ERROR_CODES = {
  CONFIG_INVALID: 'INVALID_CONFIG',
  EXECUTION_CANCELLED: 'AGENT_ABORTED',
  EXECUTION_TIMEOUT: 'ADAPTER_TIMEOUT',
  SESSION_NOT_FOUND: 'ADAPTER_SESSION_NOT_FOUND',
  SESSION_INVALID: 'INVALID_CONFIG',
  SESSION_BUSY: 'ADAPTER_EXECUTION_FAILED',
  ADAPTER_SDK_INCOMPATIBLE: 'MISSING_DEPENDENCY',
  ADAPTER_INCOMPLETE_RESULT: 'ADAPTER_EXECUTION_FAILED',
  ADAPTER_EVENT_QUEUE_OVERFLOW: 'ADAPTER_EXECUTION_FAILED',
  PROVIDER_ERROR: 'ADAPTER_EXECUTION_FAILED',
  CAPABILITY_DENIED: 'CAPABILITY_DENIED',
  PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
} as const satisfies Record<string, ForgeErrorCode>

export type PiErrorReason = keyof typeof PI_ERROR_CODES

function isPiErrorReason(reason: string): reason is PiErrorReason {
  return Object.hasOwn(PI_ERROR_CODES, reason)
}

export function piError(reason: string, message: string): ForgeError {
  const code: ForgeErrorCode = isPiErrorReason(reason) ? PI_ERROR_CODES[reason] : 'ADAPTER_EXECUTION_FAILED'
  return new ForgeError({ code, message, recoverable: false, context: { providerId: 'pi', piReason: reason } })
}

export interface PiRunConfig {
  cwd: string
  agentDir: string
  sessionDir: string
  provider: string
  model: string
  tools: string[]
  excludeTools: string[]
  thinkingLevel?: string
  systemPrompt?: string
  timeoutMs: number
  queueCapacity: number
  interactionPolicy: InteractionPolicy
}

const OPTION_KEYS = new Set(['tools', 'excludeTools', 'interactionPolicy'])
const PROVIDER_KEYS = new Set(['agentDir', 'sessionDir', 'provider', 'queueCapacity', 'tools', 'excludeTools'])

function explicitDirectory(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw piError('CONFIG_INVALID', `Pi requires an explicit absolute ${name}`)
  // Canonicalize existing host-owned roots before constructing any SDK resource.
  try { return realpathSync(value) } catch { throw piError('CONFIG_INVALID', `Pi ${name} must exist`) }
}

function toolNames(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_*-]+$/.test(name) || name.startsWith('-'))) {
    throw piError('CONFIG_INVALID', 'Pi tools must be an explicit list of names or patterns, not modifiers')
  }
  return [...value] as string[]
}

/** Snapshot and reject unsupported controls before loading or constructing the SDK. */
export function piRunConfig(config: AdapterConfig, input: AgentInput): PiRunConfig {
  const options = input.options ?? {}
  const providerOptions = config.providerOptions ?? {}
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw piError('CAPABILITY_DENIED', `Unsupported Pi input option: ${key}`)
  }
  for (const key of Object.keys(providerOptions)) {
    if (!PROVIDER_KEYS.has(key)) throw piError('CAPABILITY_DENIED', `Unsupported Pi provider option: ${key}`)
  }
  const policy = input.policyContext?.activePolicy
  const guardrails = input.policyContext?.projectedGuardrails
  if (config.apiKey !== undefined || config.env !== undefined || config.envFilter !== undefined) {
    throw piError('CAPABILITY_DENIED', 'Pi auth and environment overrides are not supported; select a host-owned profile')
  }
  if (config.sandboxMode !== undefined || policy?.sandboxMode !== undefined || policy?.networkAccess !== undefined ||
      input.maxBudgetUsd !== undefined || input.maxTurns !== undefined || input.outputSchema !== undefined ||
      policy?.maxBudgetUsd !== undefined || policy?.maxTurns !== undefined ||
      guardrails?.maxIterations !== undefined || guardrails?.maxCostCents !== undefined ||
      input.policyContext?.executionPolicy !== undefined || input.executionControlRequirement !== undefined ||
      config.thinkingBudgetTokens !== undefined || config.promptCache !== undefined || config.skipGitRepoCheck !== undefined) {
    throw piError('CAPABILITY_DENIED', 'Pi cannot enforce the requested sandbox, network, budget, turn, output or host execution control')
  }
  const interactionPolicy = structuredClone((options['interactionPolicy'] ?? config.interactionPolicy ?? { mode: 'ask-caller' }) as InteractionPolicy)
  if (!['ask-caller', 'auto-approve', 'auto-deny', 'default-answers'].includes(interactionPolicy.mode) ||
      interactionPolicy.askCaller?.timeoutFallback === 'auto-approve') {
    throw piError('CAPABILITY_DENIED', 'Pi requires a local interaction policy with deny-on-timeout')
  }
  const approvalTimeout = interactionPolicy.askCaller?.timeoutMs ?? 60_000
  if (!Number.isSafeInteger(approvalTimeout) || approvalTimeout <= 0 || approvalTimeout > 2_147_483_647) {
    throw piError('CONFIG_INVALID', 'Invalid Pi approval timeout')
  }
  if (policy?.approvalRequired === true && !['ask-caller', 'auto-deny'].includes(interactionPolicy.mode)) {
    throw piError('CAPABILITY_DENIED', 'Pi required approval needs caller approval or explicit denial')
  }
  if (policy?.toolPolicy !== undefined && !['strict', 'balanced', 'open'].includes(policy.toolPolicy)) {
    throw piError('CAPABILITY_DENIED', 'Unsupported Pi tool policy')
  }
  const provider = providerOptions['provider']
  if (typeof provider !== 'string' || !provider || typeof config.model !== 'string' || !config.model) {
    throw piError('CONFIG_INVALID', 'Pi requires an explicit provider and model')
  }
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw piError('CAPABILITY_DENIED', 'Pi currently supports only qualified OpenAI and Anthropic API-key profiles')
  }
  const timeoutMs = config.timeoutMs ?? 300_000
  const queueCapacity = providerOptions['queueCapacity'] ?? 256
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 ||
      typeof queueCapacity !== 'number' || !Number.isSafeInteger(queueCapacity) || queueCapacity < 1 || queueCapacity > 65_536) {
    throw piError('CONFIG_INVALID', 'Invalid Pi timeout or event queue capacity')
  }
  const configuredTools = toolNames(options['tools'] ?? providerOptions['tools'], ['read', 'bash', 'edit', 'write'])
  const tools = policy?.allowedTools !== undefined ? toolNames(policy.allowedTools, []) : configuredTools
  if (policy?.toolPolicy === 'strict' && policy.allowedTools === undefined) {
    throw piError('CAPABILITY_DENIED', 'Strict Pi tool policy requires an explicit allowlist')
  }
  const excludeTools = [
    ...toolNames(options['excludeTools'] ?? providerOptions['excludeTools'], []),
    ...toolNames(policy?.blockedTools, []), ...toolNames(guardrails?.blockedTools, []),
  ]
  return {
    cwd: explicitDirectory(input.workingDirectory ?? config.workingDirectory, 'working directory'),
    agentDir: explicitDirectory(providerOptions['agentDir'], 'agentDir'),
    sessionDir: explicitDirectory(providerOptions['sessionDir'], 'sessionDir'),
    provider, model: config.model, tools, excludeTools,
    thinkingLevel: config.reasoning, systemPrompt: input.systemPrompt,
    timeoutMs, queueCapacity, interactionPolicy,
  }
}

// In-process exclusion across adapter instances. This is not a cross-process lock.
const heldSessions = new Set<string>()

function holdSession(sessionDir: string, id: string): () => void {
  const key = `${sessionDir}\0${id}`
  if (heldSessions.has(key)) throw piError('SESSION_BUSY', 'Pi persisted session is already in use in this process')
  heldSessions.add(key)
  return () => { heldSessions.delete(key) }
}

function assertContained(file: string, root: string): string {
  if (!isAbsolute(file)) throw piError('SESSION_INVALID', 'Pi returned a non-absolute session path')
  let canonical: string
  try { canonical = realpathSync(file) } catch { throw piError('SESSION_INVALID', 'Pi session path is unavailable') }
  const suffix = relative(root, canonical)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw piError('SESSION_INVALID', 'Pi session path escapes the selected session directory')
  }
  return canonical
}

export function openPiManager(sdk: PiSdk, config: PiRunConfig, resumeId?: string): { manager: PiSessionManager; release: () => void } {
  if (resumeId !== undefined) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(resumeId)) throw piError('SESSION_INVALID', 'Invalid Pi session ID')
    const release = holdSession(config.sessionDir, resumeId)
    try {
      const found = sdk.SessionManager.findById(config.cwd, resumeId, config.sessionDir)
      if (!found) throw piError('SESSION_NOT_FOUND', 'Pi session ID was not found in the selected workspace')
      const file = assertContained(found, config.sessionDir)
      const manager = sdk.SessionManager.open(file, config.sessionDir)
      if (manager.getSessionId() !== resumeId || realpathSync(manager.getCwd()) !== config.cwd ||
          assertContained(manager.getSessionFile() ?? '', config.sessionDir) !== file) {
        throw piError('SESSION_INVALID', 'Pi resumed session identity or workspace does not match')
      }
      return { manager, release }
    } catch (error) { release(); throw error }
  }
  const manager = sdk.SessionManager.create(config.cwd, config.sessionDir)
  const id = manager.getSessionId()
  if (!id || realpathSync(manager.getCwd()) !== config.cwd) throw piError('SESSION_INVALID', 'Pi created a session for a different workspace')
  return { manager, release: holdSession(config.sessionDir, id) }
}

export async function createPiSession(
  sdk: PiSdk, config: PiRunConfig, manager: PiSessionManager, signal: AbortSignal, approval: PiExtensionFactory,
): Promise<PiSession> {
  const check = () => { if (signal.aborted) throw piError('EXECUTION_CANCELLED', 'Pi execution cancelled') }
  check()
  const settingsManager = sdk.SettingsManager.inMemory({
    packages: [], extensions: [], skills: [], prompts: [], themes: [],
    enableSkillCommands: false, enableAnalytics: false, enableInstallTelemetry: false,
    cacheWarming: 'off', compaction: { enabled: false },
  }, { projectTrusted: false })
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: config.cwd, agentDir: config.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [], additionalSkillPaths: [], additionalPromptTemplatePaths: [], additionalThemePaths: [],
    extensionFactories: [approval], systemPrompt: '', appendSystemPrompt: [],
    systemPromptOverride: () => config.systemPrompt ?? '', appendSystemPromptOverride: () => [],
  })
  await resourceLoader.reload()
  check()
  const authPath = join(config.agentDir, 'auth.json')
  // Public raw reader performs no file creation, locking, shell execution or
  // environment interpolation. Never instantiate the resolving AuthStorage.
  const credentials = guardedPiCredentials({
    async read(id, options) { options?.signal?.throwIfAborted(); return sdk.readStoredCredential(id, authPath) },
    async list(options) {
      options?.signal?.throwIfAborted()
      const value = sdk.readStoredCredential(config.provider, authPath)
      return value !== null && typeof value === 'object' && 'type' in value && value.type === 'api_key'
        ? [{ providerId: config.provider, type: 'api_key' }] : []
    },
    async modify() { throw piError('PROVIDER_AUTH_FAILED', 'Pi profile is read-only') },
    async delete() { throw piError('PROVIDER_AUTH_FAILED', 'Pi profile is read-only') },
  }, config.provider)
  // Fail before runtime construction, then revalidate every SDK read to close
  // logout/replacement races without consulting ambient credentials.
  await credentials.read(config.provider, { signal })
  check()
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials, modelsPath: null,
    modelsStorePath: join(config.agentDir, 'models-cache.json'),
    allowModelNetwork: false, refreshOnCreate: false, signal,
  })
  check()
  const model = modelRuntime.getModel(config.provider, config.model)
  if (!model) throw piError('CONFIG_INVALID', 'Pi selected model is not available in the explicit runtime')
  const { session } = await sdk.createAgentSession({
    cwd: config.cwd, agentDir: config.agentDir, settingsManager, resourceLoader, modelRuntime,
    sessionManager: manager, model, thinkingLevel: config.thinkingLevel,
    tools: config.tools, excludeTools: config.excludeTools,
  })
  // The caller owns late-session disposal, including cancellation during create.
  return session
}

export function guardedPiCredentials(store: PiCredentialStore, provider: string): PiCredentialStore {
  const denied = () => piError('PROVIDER_AUTH_FAILED', 'Pi requires a valid API key in the selected private profile')
  const selected = (id: string) => {
    if ((provider !== 'openai' && provider !== 'anthropic') || id !== provider) throw denied()
  }
  return {
    async read(id, options) {
      selected(id)
      let value: unknown
      try { value = await store.read(id, options) } catch { throw denied() }
      if (value === null || typeof value !== 'object' || !('type' in value) || value.type !== 'api_key'
        || !('key' in value) || typeof value.key !== 'string' || value.key.trim().length === 0
        || /^[!$]/u.test(value.key.trim())) throw denied()
      return value
    },
    async list(options) {
      try { return (await store.list(options)).filter(entry => entry.providerId === provider && entry.type === 'api_key') }
      catch { throw denied() }
    },
    async modify() { throw denied() },
    async delete() { throw denied() },
  }
}
