import { websiteTools } from '../tools/website.js'

/**
 * Runtime configuration for the Website Builder persona prompt.
 *
 * `siteSystemPrompt` is the per-site tone persona (provided by the website-app
 * runtime via `SiteTonePersona.buildSystemPrompt()`). It is appended verbatim
 * so the agent inherits brand voice, reading level, and forbidden-phrase
 * guardrails without leaking them into the framework default prompt.
 */
export interface WebsiteBuilderPersonaConfig {
  /** Injected from `SiteTonePersona.buildSystemPrompt()` at runtime. */
  siteSystemPrompt?: string
  /** Site name for context. */
  siteName?: string
  /** Current site status. */
  siteStatus?: 'DRAFT' | 'REVIEW' | 'PUBLISHED' | 'ARCHIVED'
}

/**
 * Build the system prompt for the Website Builder persona.
 *
 * The prompt is deterministic given the same `config` so it can be cached and
 * compared in tests. It is intentionally framework-agnostic — no app-specific
 * URLs, IDs, or runtime hooks.
 */
export function buildWebsiteBuilderSystemPrompt(
  config: WebsiteBuilderPersonaConfig = {},
): string {
  const lines: string[] = []

  lines.push('You are the Website Builder Agent for Datazup.')
  lines.push(
    'Your job is to design, edit, and publish marketing/content websites by',
  )
  lines.push(
    'editing validated WebsiteDocument records through structured tools — never',
  )
  lines.push('by writing arbitrary Vue or HTML files.')
  lines.push('')
  lines.push('Available tool namespaces:')
  lines.push(
    '- website.get_*       — read-only inspection (site info, routes, sections, design tokens, persona, SEO).',
  )
  lines.push(
    '- website.generate_*  — generate routes, sections, or SEO metadata from a brief.',
  )
  lines.push(
    '- website.update_*    — apply targeted patches to section content or the tone persona.',
  )
  lines.push('')
  lines.push('Operating rules:')
  lines.push(
    '- Always use `website.clarify_requirements` before any destructive change.',
  )
  lines.push(
    '- `website.publish_site` requires explicit user approval — never call it on your own initiative.',
  )
  lines.push(
    '- Prefer the smallest possible diff: read the relevant route/section first, then patch.',
  )
  lines.push(
    '- Honour the site tone persona, design tokens, and forbidden phrases when generating copy.',
  )

  if (config.siteName || config.siteStatus) {
    lines.push('')
    lines.push('Site context:')
    if (config.siteName) {
      lines.push(`- Name: ${config.siteName}`)
    }
    if (config.siteStatus) {
      lines.push(`- Status: ${config.siteStatus}`)
    }
  }

  if (config.siteSystemPrompt && config.siteSystemPrompt.trim().length > 0) {
    lines.push('')
    lines.push('Site tone persona:')
    lines.push(config.siteSystemPrompt.trim())
  }

  return lines.join('\n')
}

/**
 * Every `website.*` tool name (read + write + approval-gated).
 */
export const WEBSITE_BUILDER_TOOL_NAMES: string[] = websiteTools.map(
  (tool) => tool.name,
)

/**
 * Read-only website tools — safe to invoke without user approval and without
 * mutating site state.
 */
export const WEBSITE_BUILDER_READ_TOOLS: string[] = websiteTools
  .filter((tool) => tool.permissionLevel === 'read')
  .map((tool) => tool.name)

/**
 * Mutating website tools (creates or modifies site state). Includes both
 * approval-free writes and HITL-gated writes.
 */
export const WEBSITE_BUILDER_WRITE_TOOLS: string[] = websiteTools
  .filter((tool) => tool.permissionLevel === 'write')
  .map((tool) => tool.name)

/**
 * Subset of write tools that require an explicit human approval before
 * execution (publish, deployment plan, clarification flow).
 */
export const WEBSITE_BUILDER_APPROVAL_TOOLS: string[] = websiteTools
  .filter((tool) => tool.requiresApproval === true)
  .map((tool) => tool.name)
