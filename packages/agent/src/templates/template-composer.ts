/**
 * Template composition — merge multiple AgentTemplates into one.
 *
 * @module templates/template-composer
 */

import type { AgentTemplate, AgentTemplateCategory } from './agent-templates.js'

/** Model tier precedence: powerful > balanced > fast. */
const MODEL_TIER_RANK: Record<AgentTemplate['modelTier'], number> = {
  fast: 0,
  balanced: 1,
  powerful: 2,
}

const RANK_TO_TIER: AgentTemplate['modelTier'][] = ['fast', 'balanced', 'powerful']

/**
 * Compose multiple agent templates into a single merged template.
 *
 * Merge strategy:
 * - `id`: concatenated with `+` separator
 * - `name`: concatenated with ` + ` separator
 * - `description`: concatenated with ` | ` separator
 * - `category`: uses the category of the first template
 * - `instructions`: concatenated with `\n\n---\n\n` separator
 * - `modelTier`: highest tier wins (powerful > balanced > fast)
 * - `suggestedTools`: union of all tools (deduplicated)
 * - `guardrails`: max of each value across all templates
 * - `tags`: union of all tags (deduplicated)
 *
 * @throws {Error} If `templates` is empty.
 */
export function composeTemplates(templates: AgentTemplate[]): AgentTemplate {
  if (templates.length === 0) {
    throw new Error('composeTemplates requires at least one template')
  }

  if (templates.length === 1) {
    const only = templates[0]!
    return { ...only }
  }

  // --- ID & Name ---
  const id = templates.map(t => t.id).join('+')
  const name = templates.map(t => t.name).join(' + ')
  const description = templates.map(t => t.description).join(' | ')
  const category: AgentTemplateCategory = templates[0]!.category

  // --- Instructions ---
  const instructions = templates.map(t => t.instructions).join('\n\n---\n\n')

  // --- Model tier: highest wins ---
  let maxRank = 0
  for (const t of templates) {
    const rank = MODEL_TIER_RANK[t.modelTier]
    if (rank > maxRank) maxRank = rank
  }
  const modelTier = RANK_TO_TIER[maxRank] ?? 'fast'

  // --- Tools: union ---
  const toolSet = new Set<string>()
  for (const t of templates) {
    if (t.suggestedTools) {
      for (const tool of t.suggestedTools) {
        toolSet.add(tool)
      }
    }
  }
  const suggestedTools = toolSet.size > 0 ? [...toolSet] : undefined

  // --- Guardrails: max of each ---
  let hasGuardrails = false
  let maxTokens: number | undefined
  let maxCostCents: number | undefined
  let maxIterations: number | undefined

  for (const t of templates) {
    if (t.guardrails) {
      hasGuardrails = true
      if (t.guardrails.maxTokens !== undefined) {
        maxTokens = Math.max(maxTokens ?? 0, t.guardrails.maxTokens)
      }
      if (t.guardrails.maxCostCents !== undefined) {
        maxCostCents = Math.max(maxCostCents ?? 0, t.guardrails.maxCostCents)
      }
      if (t.guardrails.maxIterations !== undefined) {
        maxIterations = Math.max(maxIterations ?? 0, t.guardrails.maxIterations)
      }
    }
  }

  const guardrails = hasGuardrails
    ? {
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(maxCostCents !== undefined ? { maxCostCents } : {}),
        ...(maxIterations !== undefined ? { maxIterations } : {}),
      }
    : undefined

  // --- Tags: union ---
  const tagSet = new Set<string>()
  for (const t of templates) {
    for (const tag of t.tags) {
      tagSet.add(tag)
    }
  }

  return {
    id,
    name,
    description,
    category,
    instructions,
    modelTier,
    suggestedTools,
    guardrails,
    tags: [...tagSet],
  }
}
