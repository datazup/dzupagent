/**
 * Skill resolution for codegen pipeline phases.
 *
 * Resolves skill names declared in PhaseConfig.skills[] into actual content
 * and injects them into the pipeline state so phase executors can consume them.
 *
 * Resolution order (first match wins):
 *   1. Provided SkillRegistry (in-memory, fastest)
 *   2. Provided SkillLoader (filesystem SKILL.md discovery)
 *
 * The resolved content is placed at:
 *   state.__skills_<phaseName>  — array of { name, content } objects
 *   state.__skills_prompt_<phaseName> — pre-formatted prompt section (string)
 */

import type { SkillRegistry, SkillLoader } from '@dzupagent/core'
import type { SkillResolutionContext } from '@dzupagent/core'

export interface ResolvedSkill {
  name: string
  content: string
  source: 'registry' | 'loader'
}

export interface SkillResolverConfig {
  /** Optional in-memory skill registry (checked first) */
  registry?: SkillRegistry | undefined
  /** Optional filesystem skill loader (checked second) */
  loader?: SkillLoader | undefined
}

/**
 * Resolves a list of skill names into their content using registry and/or loader.
 * Unresolved names are silently skipped (logged to console.warn).
 */
export async function resolveSkills(
  skillNames: string[],
  config: SkillResolverConfig,
): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = []

  for (const name of skillNames) {
    // 1. Registry lookup
    if (config.registry) {
      const entry = config.registry.get(name)
      if (entry) {
        resolved.push({ name, content: entry.instructions, source: 'registry' })
        continue
      }
    }

    // 2. Filesystem loader
    if (config.loader) {
      try {
        const content = await config.loader.loadSkillContent(name)
        if (content !== null) {
          resolved.push({ name, content, source: 'loader' })
          continue
        }
      } catch {
        // loader throws → fall through to warn
      }
    }

    console.warn(`[SkillResolver] skill "${name}" not found — skipping`)
  }

  return resolved
}

/**
 * Format resolved skills as a prompt section string.
 * Suitable for appending to a system prompt.
 */
export function formatResolvedSkillsPrompt(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return ''

  const sections = skills.map(s => `### ${s.name}\n${s.content.trim()}`).join('\n\n')
  return `## Active Skills\n\n${sections}`
}

/**
 * Inject resolved skills into pipeline state for a given phase.
 *
 * Sets:
 *   state[`__skills_${phaseName}`]         — ResolvedSkill[]
 *   state[`__skills_prompt_${phaseName}`]  — formatted prompt string
 *   state[`__skill_context`]               — SkillResolutionContext (if provided)
 */
export function injectSkillsIntoState(
  state: Record<string, unknown>,
  phaseName: string,
  skills: ResolvedSkill[],
  context?: SkillResolutionContext,
): void {
  const key = phaseName.replace(/[^a-z0-9_]/gi, '_')
  state[`__skills_${key}`] = skills
  state[`__skills_prompt_${key}`] = formatResolvedSkillsPrompt(skills)
  if (context) {
    state['__skill_context'] = context
  }
}

/**
 * Convenience: resolve and inject skills for a phase in one call.
 */
export async function resolveAndInjectSkills(
  skillNames: string[],
  phaseName: string,
  state: Record<string, unknown>,
  config: SkillResolverConfig,
  context?: SkillResolutionContext,
): Promise<ResolvedSkill[]> {
  if (skillNames.length === 0) return []
  const resolved = await resolveSkills(skillNames, config)
  injectSkillsIntoState(state, phaseName, resolved, context)
  return resolved
}
