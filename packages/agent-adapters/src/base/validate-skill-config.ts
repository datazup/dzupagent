/**
 * Shared validation for {@link CompiledAdapterSkill} runtime configs.
 *
 * Every adapter skill compiler (Claude, Codex, CLI-family) checked the same
 * four invariants:
 *
 *   1. `providerId` matches the compiler's expected provider
 *   2. `runtimeConfig.systemPrompt` is a string
 *   3. `hash` is a non-empty string
 *   4. `projectionVersion` is a non-empty string
 *
 * Centralizing the logic here keeps the per-provider compilers focused on
 * provider-specific checks (e.g. Claude's `maxBudgetTokens`, CLI feature
 * warnings) and avoids drift between the three implementations.
 */

import type { AdapterProviderId } from '../types.js'
import type { CompiledAdapterSkill } from '../skills/adapter-skill-types.js'

/**
 * Run the four shared validation checks against a compiled skill.
 * Returns an array of error strings — empty when the skill passes.
 */
export function validateCompiledSkillCommon(
  compiled: CompiledAdapterSkill,
  expectedProviderId: AdapterProviderId,
): string[] {
  const errors: string[] = []

  if (compiled.providerId !== expectedProviderId) {
    errors.push(`Expected providerId '${expectedProviderId}', got '${compiled.providerId}'`)
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

  return errors
}
