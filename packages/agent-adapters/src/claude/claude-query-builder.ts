/**
 * Claude adapter request-shaping helpers.
 *
 * Encapsulates building the SDK `query()` options object and converting raw
 * SDK session records into the unified `SessionInfo` shape. Kept as
 * standalone functions so they can be unit-tested without instantiating the
 * full adapter.
 */
import { SystemPromptBuilder } from '../prompts/system-prompt-builder.js'
import type {
  AdapterConfig,
  AgentInput,
  InteractionPolicy,
  SessionInfo,
} from '../types.js'
import { mapSandboxMode } from './claude-event-mapper.js'

export interface BuildQueryOptionsArgs {
  input: AgentInput
  config: AdapterConfig
  /** Resolved interaction policy — only `mode` is consulted. */
  interactionPolicy: InteractionPolicy
}

export function buildQueryOptions({
  input,
  config,
  interactionPolicy,
}: BuildQueryOptionsArgs): Record<string, unknown> {
  const options: Record<string, unknown> = {}

  if (input.systemPrompt) {
    const mode = (input.options?.['systemPromptMode'] as string | undefined) ?? 'append'
    const builder = new SystemPromptBuilder(input.systemPrompt, {
      claudeMode: mode === 'replace' ? 'replace' : 'append',
    })
    options['systemPrompt'] = builder.buildFor('claude')
  }
  if (input.maxTurns !== undefined) {
    options['maxTurns'] = input.maxTurns
  }
  if (input.maxBudgetUsd !== undefined) {
    options['maxBudgetUsd'] = input.maxBudgetUsd
  }
  if (input.workingDirectory ?? config.workingDirectory) {
    options['cwd'] = input.workingDirectory ?? config.workingDirectory
  }
  // Determine permissionMode:
  // - sandboxMode takes priority for explicit permission control
  // - interaction policy 'auto-approve' bypasses permissions only when no sandboxMode is set
  const sandboxMode = typeof input.options?.['sandboxMode'] === 'string'
    ? input.options['sandboxMode'] as AdapterConfig['sandboxMode']
    : config.sandboxMode
  if (typeof input.options?.['permissionMode'] === 'string') {
    options['permissionMode'] = input.options['permissionMode']
  } else if (sandboxMode) {
    options['permissionMode'] = mapSandboxMode(sandboxMode)
  } else if (interactionPolicy.mode === 'auto-approve') {
    options['permissionMode'] = 'bypassPermissions'
  }
  // Extended thinking for Claude: reasoning='high' or explicit thinkingBudgetTokens
  const thinkingBudget = config.thinkingBudgetTokens ?? (config.reasoning === 'high' ? 10000 : 0)
  if (thinkingBudget > 0) {
    options['thinking'] = { type: 'enabled', budget_tokens: thinkingBudget }
  }

  // Prompt caching: enabled by default ('auto') unless explicitly disabled.
  // Adds cache_control markers on the system prompt so repeated runs with the
  // same persona/tools pay write cost once and read cost (~10%) thereafter.
  if (config.promptCache !== 'off') {
    options['promptCaching'] = true
  }

  if (input.resumeSessionId) {
    options['resume'] = input.resumeSessionId
  }

  // Merge adapter-specific options from input
  if (input.options) {
    for (const [key, value] of Object.entries(input.options)) {
      if (
        key === 'continue' ||
        key === 'forkSession' ||
        key === 'resume' ||
        key === 'permissionMode'
      ) {
        options[key] = value
      }
    }
  }

  // Merge provider-specific config options (may override promptCaching if needed)
  if (config.providerOptions) {
    for (const [key, value] of Object.entries(config.providerOptions)) {
      options[key] = value
    }
  }

  return {
    prompt: input.prompt,
    options,
  }
}

export function toSessionInfo(raw: unknown): SessionInfo {
  const obj = raw as Record<string, unknown>
  return {
    sessionId: typeof obj['session_id'] === 'string' ? obj['session_id'] : String(obj['id'] ?? ''),
    providerId: 'claude',
    createdAt: obj['created_at'] instanceof Date
      ? obj['created_at']
      : new Date(typeof obj['created_at'] === 'string' || typeof obj['created_at'] === 'number'
        ? obj['created_at']
        : 0),
    lastActiveAt: obj['last_active_at'] instanceof Date
      ? obj['last_active_at']
      : new Date(typeof obj['last_active_at'] === 'string' || typeof obj['last_active_at'] === 'number'
        ? obj['last_active_at']
        : Date.now()),
    ...(typeof obj['cwd'] === 'string' ? { workingDirectory: obj['cwd'] } : {}),
    ...(typeof obj['metadata'] === 'object' && obj['metadata'] !== null
      ? { metadata: obj['metadata'] as Record<string, unknown> }
      : {}),
  }
}
