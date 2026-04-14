/**
 * CLI-family adapter skill compiler.
 *
 * Handles providers that are invoked via CLI spawning:
 * gemini, qwen, crush, goose, openrouter.
 *
 * Unsupported constraints emit warnings during validation
 * rather than compile-time errors, since CLI adapters have
 * limited runtime configuration surface.
 */

import type { AdapterProviderId } from '../../types.js'
import type { AdapterSkillBundle, AdapterSkillCompiler, CompiledAdapterSkill } from '../adapter-skill-types.js'
import { PROJECTION_VERSION, deterministicHash, buildSystemPrompt, extractTools } from './compiler-utils.js'

/** Features that a CLI provider can support. */
type CliFeature = 'systemPrompt' | 'toolBindings' | 'approvalMode' | 'networkPolicy' | 'budgetLimit'

/** Feature support map per CLI provider. */
const PROVIDER_FEATURES: Record<string, readonly CliFeature[]> = {
  gemini: ['systemPrompt', 'toolBindings'],
  qwen: ['systemPrompt', 'toolBindings'],
  crush: ['systemPrompt'],
  goose: ['systemPrompt', 'toolBindings'],
  openrouter: ['systemPrompt'],
}

/** CLI provider IDs handled by this compiler. */
const CLI_PROVIDER_IDS: ReadonlySet<AdapterProviderId> = new Set([
  'gemini',
  'qwen',
  'crush',
  'goose',
  'openrouter',
])

export function isCliProviderId(id: AdapterProviderId): boolean {
  return CLI_PROVIDER_IDS.has(id)
}

export class CliSkillCompiler implements AdapterSkillCompiler {
  readonly providerId: AdapterProviderId

  constructor(providerId: AdapterProviderId) {
    if (!CLI_PROVIDER_IDS.has(providerId)) {
      throw new Error(`CliSkillCompiler does not support provider '${providerId}'`)
    }
    this.providerId = providerId
  }

  compile(bundle: AdapterSkillBundle): CompiledAdapterSkill {
    const systemPrompt = buildSystemPrompt(bundle)
    const requiredTools = extractTools(bundle, 'required')
    const blockedTools = extractTools(bundle, 'blocked')
    const supportedFeatures = [...(PROVIDER_FEATURES[this.providerId] ?? [])]

    const runtimeConfig: Record<string, unknown> = {
      systemPrompt,
      requiredTools,
      blockedTools,
      supportedFeatures,
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

    // Warn about unsupported constraints (validation warnings, not errors)
    const features = new Set(PROVIDER_FEATURES[this.providerId] ?? [])
    const warnings: string[] = []

    if (!features.has('approvalMode')) {
      warnings.push(`Provider '${this.providerId}' does not support approvalMode constraint`)
    }
    if (!features.has('networkPolicy')) {
      warnings.push(`Provider '${this.providerId}' does not support networkPolicy constraint`)
    }
    if (!features.has('budgetLimit')) {
      warnings.push(`Provider '${this.providerId}' does not support budgetLimit constraint`)
    }

    // Warnings are included as non-fatal messages; ok is still true if only warnings
    if (errors.length > 0) {
      return { ok: false, errors: [...errors, ...warnings] }
    }
    if (warnings.length > 0) {
      return { ok: true, errors: warnings }
    }
    return { ok: true }
  }
}
