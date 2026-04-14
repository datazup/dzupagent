/**
 * Claude adapter skill compiler.
 *
 * Compiles an AdapterSkillBundle into runtime configuration
 * suitable for the Claude Agent SDK adapter.
 */

import type { AdapterSkillBundle, AdapterSkillCompiler, CompiledAdapterSkill } from '../adapter-skill-types.js'
import { PROJECTION_VERSION, deterministicHash, buildSystemPrompt, extractTools } from './compiler-utils.js'

/** Rough estimate: 1 USD ~= 1M tokens. */
const TOKENS_PER_USD = 1_000_000

/**
 * Map approval mode to Claude permission mode.
 *
 * - `auto` -> `auto`
 * - `required` -> `manual`
 * - `conditional` -> `conditional`
 */
function mapPermissionMode(approvalMode: string | undefined): string {
  switch (approvalMode) {
    case 'required':
      return 'manual'
    case 'conditional':
      return 'conditional'
    default:
      return 'auto'
  }
}

export class ClaudeSkillCompiler implements AdapterSkillCompiler {
  readonly providerId = 'claude' as const

  compile(bundle: AdapterSkillBundle): CompiledAdapterSkill {
    const systemPrompt = buildSystemPrompt(bundle)
    const requiredTools = extractTools(bundle, 'required')
    const blockedTools = extractTools(bundle, 'blocked')

    const runtimeConfig: Record<string, unknown> = {
      systemPrompt,
      permissionMode: mapPermissionMode(bundle.constraints.approvalMode),
      requiredTools,
      blockedTools,
    }

    if (bundle.constraints.maxBudgetUsd !== undefined) {
      runtimeConfig['maxBudgetTokens'] = Math.round(bundle.constraints.maxBudgetUsd * TOKENS_PER_USD)
    }

    const hashInput = `${bundle.bundleId}:${bundle.skillSetVersion}:${this.providerId}`
    const hash = deterministicHash(hashInput)

    return {
      providerId: this.providerId,
      projectionVersion: PROJECTION_VERSION,
      runtimeConfig,
      hash,
    }
  }

  validate(compiled: CompiledAdapterSkill): { ok: boolean; errors?: string[] } {
    const errors: string[] = []

    if (compiled.providerId !== this.providerId) {
      errors.push(`Expected providerId '${this.providerId}', got '${compiled.providerId}'`)
    }
    if (typeof compiled.runtimeConfig['systemPrompt'] !== 'string') {
      errors.push('Missing or invalid runtimeConfig.systemPrompt')
    }
    if (!compiled.hash || typeof compiled.hash !== 'string') {
      errors.push('Missing or invalid hash')
    }
    if (!compiled.projectionVersion || typeof compiled.projectionVersion !== 'string') {
      errors.push('Missing or invalid projectionVersion')
    }

    const maxBudget = compiled.runtimeConfig['maxBudgetTokens']
    if (maxBudget !== undefined && (typeof maxBudget !== 'number' || maxBudget <= 0)) {
      errors.push('runtimeConfig.maxBudgetTokens must be a positive number when set')
    }

    return errors.length === 0 ? { ok: true } : { ok: false, errors }
  }
}
