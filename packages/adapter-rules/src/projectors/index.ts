/**
 * Provider config projectors.
 *
 * Each projector maps an accumulated RuntimePlan + CompileContext into a
 * provider-native config patch (for example, Claude SDK permissions,
 * Codex approvalPolicy, Gemini settings.json, Qwen config.json,
 * Goose config.yaml, or Crush config.toml). Projectors are pure — they
 * never touch the filesystem and never mutate the plan.
 */

import type { AdapterProviderId } from '@dzupagent/adapter-types'

import type { CompileContext, RuntimePlan } from '../types.js'

import { projectClaudeConfig } from './claude.js'
import { projectCodexConfig } from './codex.js'
import { projectCrushConfig } from './crush.js'
import { projectGeminiConfig } from './gemini.js'
import { projectGooseConfig } from './goose.js'
import { projectQwenConfig } from './qwen.js'
import { buildWatcherRegistrations } from './watchers.js'

export type ProjectorFn = (
  plan: RuntimePlan,
  context: CompileContext,
) => Record<string, unknown>

const PROJECTORS: Partial<Record<AdapterProviderId, ProjectorFn>> = {
  claude: projectClaudeConfig,
  codex: projectCodexConfig,
  gemini: projectGeminiConfig,
  'gemini-sdk': projectGeminiConfig,
  qwen: projectQwenConfig,
  goose: projectGooseConfig,
  crush: projectCrushConfig,
}

export function projectProviderConfig(
  plan: RuntimePlan,
  context: CompileContext,
): Record<string, unknown> {
  const projector = PROJECTORS[context.providerId]
  if (projector === undefined) return {}
  return projector(plan, context)
}

export {
  buildWatcherRegistrations,
  projectClaudeConfig,
  projectCodexConfig,
  projectCrushConfig,
  projectGeminiConfig,
  projectGooseConfig,
  projectQwenConfig,
}
