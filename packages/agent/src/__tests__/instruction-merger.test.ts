import { describe, it, expect } from 'vitest'
import { mergeInstructions } from '../instructions/instruction-merger.js'
import type { AgentsMdSection } from '../instructions/agents-md-parser.js'

describe('mergeInstructions', () => {
  const staticInstructions = 'You are a helpful assistant.'

  const sections: AgentsMdSection[] = [
    {
      agentId: 'planner',
      role: 'Plans tasks',
      instructions: 'Break down complex requests into steps.',
      tools: ['search', 'analyze'],
    },
    {
      agentId: 'executor',
      role: 'Executes plans',
      instructions: 'Follow the plan precisely.',
      constraints: ['Never skip steps'],
      childSections: [
        {
          agentId: 'code-writer',
          instructions: 'Write clean TypeScript code.',
          tools: ['write_file', 'read_file'],
        },
      ],
    },
  ]

  it('returns static instructions when no AGENTS.md sections', () => {
    const result = mergeInstructions(staticInstructions, [])

    expect(result.systemPrompt).toBe(staticInstructions)
    expect(result.agentHierarchy).toEqual([])
    expect(result.sources).toEqual([])
  })

  it('merges all sections when no agentId filter', () => {
    const result = mergeInstructions(staticInstructions, sections)

    expect(result.systemPrompt).toContain('You are a helpful assistant.')
    expect(result.systemPrompt).toContain('Agent Configuration (from AGENTS.md)')
    expect(result.systemPrompt).toContain('planner')
    expect(result.systemPrompt).toContain('executor')
    expect(result.systemPrompt).toContain('code-writer')
    expect(result.agentHierarchy).toEqual(sections)
  })

  it('filters to specific agent by ID', () => {
    const result = mergeInstructions(staticInstructions, sections, 'planner')

    expect(result.systemPrompt).toContain('planner')
    expect(result.systemPrompt).not.toContain('executor')
    expect(result.systemPrompt).not.toContain('code-writer')
  })

  it('includes parent context when filtering to a child agent', () => {
    const result = mergeInstructions(staticInstructions, sections, 'code-writer')

    // Should include the parent (executor) for context
    expect(result.systemPrompt).toContain('executor')
    expect(result.systemPrompt).toContain('code-writer')
    // But not the unrelated planner
    expect(result.systemPrompt).not.toContain('planner')
  })

  it('returns static instructions when agentId not found', () => {
    const result = mergeInstructions(staticInstructions, sections, 'nonexistent')

    // No sections match, so just the static instructions
    expect(result.systemPrompt).toBe(staticInstructions)
  })

  it('preserves the full hierarchy in agentHierarchy regardless of filter', () => {
    const result = mergeInstructions(staticInstructions, sections, 'planner')

    // agentHierarchy always contains the full tree
    expect(result.agentHierarchy).toEqual(sections)
  })

  it('includes sources when provided', () => {
    const sources = ['/project/AGENTS.md', '/project/sub/AGENTS.md']
    const result = mergeInstructions(staticInstructions, sections, undefined, sources)

    expect(result.sources).toEqual(sources)
  })

  it('renders role, tools, and constraints in the merged prompt', () => {
    const result = mergeInstructions(staticInstructions, sections)

    expect(result.systemPrompt).toContain('Plans tasks')
    expect(result.systemPrompt).toContain('search, analyze')
    expect(result.systemPrompt).toContain('Never skip steps')
  })
})
