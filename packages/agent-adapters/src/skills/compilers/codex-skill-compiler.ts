/**
 * Codex adapter skill compiler.
 *
 * Compiles an AdapterSkillBundle into runtime configuration
 * suitable for the Codex SDK adapter.
 */

import type { AdapterSkillBundle, AdapterSkillCompiler, CompiledAdapterSkill } from '../adapter-skill-types.js'
import { PROJECTION_VERSION, deterministicHash, buildSystemPrompt, extractTools } from './compiler-utils.js'

export class CodexSkillCompiler implements AdapterSkillCompiler {
  readonly providerId = 'codex' as const

  compile(bundle: AdapterSkillBundle): CompiledAdapterSkill {
    const systemPrompt = buildSystemPrompt(bundle)
    const requiredTools = extractTools(bundle, 'required')
    const blockedTools = extractTools(bundle, 'blocked')

    const runtimeConfig: Record<string, unknown> = {
      systemPrompt,
      approvalMode: bundle.constraints.approvalMode ?? 'auto',
      networkPolicy: bundle.constraints.networkPolicy ?? 'off',
      requiredTools,
      blockedTools,
    }

    const hashInput = `${bundle.bundleId}:${bundle.skillSetVersion}:${this.providerId}:${buildSystemPrompt(bundle)}`
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

    return errors.length === 0 ? { ok: true } : { ok: false, errors }
  }
}
