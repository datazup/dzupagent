import type { AdapterConfig, AgentInput } from '../types.js'
import type { CodexAppServerClientDependencies } from './codex-app-server-client.js'
import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_INTERRUPT_GRACE_MS,
  MAX_EXECUTION_TIMEOUT_MS,
  MAX_INTERRUPT_GRACE_MS,
  type CodexAppServerAdapterOptions,
} from './codex-app-server-adapter-contracts.js'
import { toCodexSandboxMode } from './codex-helpers.js'

/**
 * Strips the app-server-only options back down to the generic adapter config, so
 * the binding, the executable identity and the injected dependencies cannot leak
 * into anything that treats its config as plain provider settings.
 */
export function adapterConfig(options: CodexAppServerAdapterOptions): AdapterConfig {
  const {
    attemptBinding: _attemptBinding,
    executable: _executable,
    clientLimits: _clientLimits,
    interruptGraceMs: _interruptGraceMs,
    dependencies: _dependencies,
    ...config
  } = options
  return config
}

/**
 * Narrows the adapter's dependency bag to the subset the client accepts, keeping
 * `now` adapter-local: the adapter stamps wall-clock event timestamps while the
 * client only ever needs the monotonic source its deadlines are measured against.
 */
export function clientDependencies(
  options: CodexAppServerAdapterOptions,
): CodexAppServerClientDependencies | undefined {
  const dependencies = options.dependencies
  if (!dependencies) return undefined
  const selected: CodexAppServerClientDependencies = {
    ...(dependencies.spawn ? { spawn: dependencies.spawn } : {}),
    ...(dependencies.realpath ? { realpath: dependencies.realpath } : {}),
    ...(dependencies.stat ? { stat: dependencies.stat } : {}),
    ...(dependencies.access ? { access: dependencies.access } : {}),
    ...(dependencies.digestArtifact ? { digestArtifact: dependencies.digestArtifact } : {}),
    ...(dependencies.monotonicNow ? { monotonicNow: dependencies.monotonicNow } : {}),
  }
  return Object.keys(selected).length > 0 ? selected : undefined
}

export function interruptGrace(value: number | undefined): number {
  if (value === undefined) return DEFAULT_INTERRUPT_GRACE_MS
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INTERRUPT_GRACE_MS) {
    throw new Error(`Codex app-server interrupt grace must be an integer between 1 and ${MAX_INTERRUPT_GRACE_MS}`)
  }
  return value
}

export function executionTimeout(input: AgentInput, config: AdapterConfig): number {
  const candidate = typeof input.options?.['timeoutMs'] === 'number'
    ? input.options['timeoutMs']
    : config.timeoutMs
  if (candidate === undefined) return DEFAULT_EXECUTION_TIMEOUT_MS
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_EXECUTION_TIMEOUT_MS) {
    throw new Error('Codex app-server execution timeout is invalid')
  }
  return candidate
}

export function threadStartParams(
  input: AgentInput,
  config: AdapterConfig,
): Record<string, unknown> {
  const cwd = effectiveWorkingDirectory(input, config)
  const model = effectiveModel(input, config)
  return {
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(input.systemPrompt ? { developerInstructions: input.systemPrompt } : {}),
    ...(config.sandboxMode ? { sandbox: toCodexSandboxMode(config.sandboxMode) } : {}),
  }
}

export function threadResumeParams(
  threadId: string,
  input: AgentInput,
  config: AdapterConfig,
): Record<string, unknown> {
  return { threadId, ...threadStartParams(input, config) }
}

export function turnStartParams(
  threadId: string,
  input: AgentInput,
  config: AdapterConfig,
): Record<string, unknown> {
  const cwd = effectiveWorkingDirectory(input, config)
  const model = effectiveModel(input, config)
  return {
    threadId,
    input: [{ type: 'text', text: input.prompt }],
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    ...(config.reasoning ? { effort: config.reasoning } : {}),
  }
}

/*
 * Per-call input outranks adapter config for both of the values below, and the
 * same resolution has to be used when building the request and when checking the
 * response: the thread assertions compare what the provider echoed against what
 * was effectively asked for, so a second, differently-derived value would make
 * that comparison meaningless.
 */
export function effectiveWorkingDirectory(
  input: AgentInput,
  config: AdapterConfig,
): string | undefined {
  return input.workingDirectory ?? config.workingDirectory
}

export function effectiveModel(input: AgentInput, config: AdapterConfig): string | undefined {
  return typeof input.options?.['model'] === 'string'
    ? input.options['model']
    : config.model
}
