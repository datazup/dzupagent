import type { SkillRegistryEntry } from '@dzupagent/core'
import type { AdapterProviderId, AgentInput } from '../types.js'
import type { AdapterSkillBundle } from './adapter-skill-types.js'

/** Result of projecting skills for a provider */
export interface SkillProjection {
  /** System prompt content to prepend/append */
  systemPromptSection: string
  /** Provider-specific configuration overrides */
  providerOptions?: Record<string, unknown>
  /** Tool names that should be enabled for this skill set */
  requiredTools: string[]
  /** Number of skills projected */
  skillCount: number
}

/** Options for skill projection */
export interface ProjectionOptions {
  /** Max total characters for skill instructions. Default: 10000 */
  maxInstructionLength?: number
  /** Format style. Default: 'detailed' */
  format?: 'detailed' | 'compact' | 'minimal'
  /** Whether to include tool requirements. Default: true */
  includeTools?: boolean
}

/**
 * Projects skill definitions into adapter-specific formats.
 *
 * Each provider has an idiomatic way of receiving "skill" context:
 * - **Claude**: structured markdown sections (AGENTS.md style)
 * - **Codex**: direct instruction blocks delimited by `===`
 * - **Gemini**: XML-style `<skills>/<skill>` tags
 * - **Generic** (qwen, crush, goose, openrouter): markdown headers
 */
export class SkillProjector {
  /**
   * Project skills for a specific provider.
   * Returns formatted instructions ready for system prompt injection.
   */
  project(
    skills: readonly SkillRegistryEntry[],
    providerId: AdapterProviderId,
    options?: ProjectionOptions,
  ): SkillProjection {
    if (skills.length === 0) {
      return { systemPromptSection: '', requiredTools: [], skillCount: 0 }
    }

    const maxLen = options?.maxInstructionLength ?? 10_000
    const format = options?.format ?? 'detailed'
    const includeTools = options?.includeTools ?? true

    // Collect required tools (deduplicated, stable order)
    const requiredTools = includeTools
      ? [...new Set(skills.flatMap((s) => s.requiredTools ?? []))]
      : []

    // Format based on provider
    const systemPromptSection = this.formatForProvider(skills, providerId, format, maxLen)

    return {
      systemPromptSection,
      requiredTools,
      skillCount: skills.length,
    }
  }

  /**
   * Project adapter skill bundles for a specific provider.
   *
   * Converts each {@link AdapterSkillBundle} into the internal
   * {@link SkillRegistryEntry} format and delegates to the existing
   * provider-specific formatting logic.
   *
   * Prompt sections are concatenated in priority order (ascending).
   * Only tool bindings with `mode === 'required'` are included.
   */
  projectBundles(
    bundles: readonly AdapterSkillBundle[],
    providerId: AdapterProviderId,
    options?: ProjectionOptions,
  ): SkillProjection {
    if (bundles.length === 0) {
      return { systemPromptSection: '', requiredTools: [], skillCount: 0 }
    }

    const entries: SkillRegistryEntry[] = bundles.map((bundle) => {
      const sortedSections = [...bundle.promptSections].sort(
        (a, b) => a.priority - b.priority,
      )
      const instructions = sortedSections.map((s) => s.content).join('\n\n')

      const requiredTools = bundle.toolBindings
        .filter((b) => b.mode === 'required')
        .map((b) => b.toolName)

      return {
        id: bundle.bundleId,
        name: bundle.bundleId,
        description: instructions.slice(0, 120) || bundle.bundleId,
        instructions,
        requiredTools,
      }
    })

    return this.project(entries, providerId, options)
  }

  /**
   * Apply a skill projection to an {@link AgentInput}.
   * Prepends skill instructions to the system prompt.
   */
  applyToInput(input: AgentInput, projection: SkillProjection): AgentInput {
    if (!projection.systemPromptSection) return input

    const existingPrompt = input.systemPrompt ?? ''
    const separator = existingPrompt ? '\n\n---\n\n' : ''

    return {
      ...input,
      systemPrompt: `${projection.systemPromptSection}${separator}${existingPrompt}`,
    }
  }

  // ---------------------------------------------------------------------------
  // Provider-specific formatters
  // ---------------------------------------------------------------------------

  private formatForProvider(
    skills: readonly SkillRegistryEntry[],
    providerId: AdapterProviderId,
    format: 'detailed' | 'compact' | 'minimal',
    maxLen: number,
  ): string {
    switch (providerId) {
      case 'claude':
        return this.formatForClaude(skills, format, maxLen)
      case 'codex':
        return this.formatForCodex(skills, format, maxLen)
      case 'gemini':
        return this.formatForGemini(skills, format, maxLen)
      default:
        return this.formatGeneric(skills, format, maxLen)
    }
  }

  /** Claude: structured markdown sections (AGENTS.md style) */
  private formatForClaude(
    skills: readonly SkillRegistryEntry[],
    format: 'detailed' | 'compact' | 'minimal',
    maxLen: number,
  ): string {
    const header = '# Active Skills\n\n'
    const sections = skills.map((s) => {
      if (format === 'minimal') return `- **${s.name}**: ${s.description}`
      if (format === 'compact')
        return `## ${s.name}\n${s.description}\n${this.truncate(s.instructions, 200)}`
      return `## ${s.name}\n\n${s.description}\n\n${s.instructions}`
    })
    return this.truncate(header + sections.join('\n\n'), maxLen)
  }

  /** Codex: direct instruction blocks delimited by `===` */
  private formatForCodex(
    skills: readonly SkillRegistryEntry[],
    format: 'detailed' | 'compact' | 'minimal',
    maxLen: number,
  ): string {
    const header = 'Active capabilities:\n\n'
    const sections = skills.map((s) => {
      if (format === 'minimal') return `[${s.name}] ${s.description}`
      const body =
        format === 'compact' ? this.truncate(s.instructions, 200) : s.instructions
      return `=== ${s.name} ===\n${s.description}\n${body}`
    })
    return this.truncate(header + sections.join('\n\n'), maxLen)
  }

  /** Gemini: XML-style context tags */
  private formatForGemini(
    skills: readonly SkillRegistryEntry[],
    format: 'detailed' | 'compact' | 'minimal',
    maxLen: number,
  ): string {
    const header = '<skills>\n'
    const footer = '\n</skills>'
    const sections = skills.map((s) => {
      if (format === 'minimal') return `<skill name="${s.name}">${s.description}</skill>`
      const body =
        format === 'compact' ? this.truncate(s.instructions, 200) : s.instructions
      return `<skill name="${s.name}">\n<description>${s.description}</description>\n<instructions>\n${body}\n</instructions>\n</skill>`
    })
    return this.truncate(header + sections.join('\n') + footer, maxLen)
  }

  /** Generic fallback: markdown headers */
  private formatGeneric(
    skills: readonly SkillRegistryEntry[],
    format: 'detailed' | 'compact' | 'minimal',
    maxLen: number,
  ): string {
    const header = '# Skills\n\n'
    const sections = skills.map((s) => {
      if (format === 'minimal') return `- ${s.name}: ${s.description}`
      const body =
        format === 'compact' ? this.truncate(s.instructions, 200) : s.instructions
      return `## ${s.name}\n${s.description}\n${body}`
    })
    return this.truncate(header + sections.join('\n\n'), maxLen)
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + '...'
  }
}
