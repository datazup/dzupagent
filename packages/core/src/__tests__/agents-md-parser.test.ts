import { describe, it, expect } from 'vitest'
import { parseAgentsMd, mergeAgentsMdConfigs } from '../skills/agents-md-parser.js'

describe('parseAgentsMd', () => {
  it('parses top-level instructions', () => {
    const result = parseAgentsMd('Always use TypeScript strict mode.\nNever use `any`.')
    expect(result.instructions).toHaveLength(1)
    expect(result.instructions[0]).toContain('TypeScript strict')
  })

  it('parses named sections as instructions', () => {
    const content = `## Code Style
Use camelCase for variables.

## Testing
Write vitest tests for all new code.`

    const result = parseAgentsMd(content)
    expect(result.instructions).toHaveLength(2)
    expect(result.instructions[0]).toContain('Code Style')
    expect(result.instructions[1]).toContain('vitest')
  })

  it('parses glob-based conditional rules', () => {
    const content = `## *.test.ts
Always include describe/it blocks.

## src/api/**
Use Express request handlers.`

    const result = parseAgentsMd(content)
    expect(result.rules).toHaveLength(2)
    expect(result.rules[0]!.glob).toBe('*.test.ts')
    expect(result.rules[1]!.glob).toBe('src/api/**')
  })

  it('parses tool allow/block list', () => {
    const content = `## Tools
- read_file
- write_file
- !delete_file
- !rm_rf`

    const result = parseAgentsMd(content)
    expect(result.allowedTools).toEqual(['read_file', 'write_file'])
    expect(result.blockedTools).toEqual(['delete_file', 'rm_rf'])
  })

  it('handles mixed content', () => {
    const content = `Use TypeScript.

## Code Rules
No any types.

## *.vue
Use Composition API.

## Tools
- edit_file
- !force_push`

    const result = parseAgentsMd(content)
    expect(result.instructions).toHaveLength(2) // top-level + Code Rules
    expect(result.rules).toHaveLength(1) // *.vue
    expect(result.allowedTools).toEqual(['edit_file'])
    expect(result.blockedTools).toEqual(['force_push'])
  })

  it('handles empty content', () => {
    const result = parseAgentsMd('')
    expect(result.instructions).toHaveLength(0)
    expect(result.rules).toHaveLength(0)
  })
})

describe('mergeAgentsMdConfigs', () => {
  it('merges instructions from multiple configs', () => {
    const merged = mergeAgentsMdConfigs([
      { instructions: ['Rule A'], rules: [] },
      { instructions: ['Rule B'], rules: [] },
    ])
    expect(merged.instructions).toEqual(['Rule A', 'Rule B'])
  })

  it('deduplicates tool lists', () => {
    const merged = mergeAgentsMdConfigs([
      { instructions: [], rules: [], allowedTools: ['a', 'b'] },
      { instructions: [], rules: [], allowedTools: ['b', 'c'] },
    ])
    expect(merged.allowedTools).toEqual(['a', 'b', 'c'])
  })

  it('merges rules', () => {
    const merged = mergeAgentsMdConfigs([
      { instructions: [], rules: [{ glob: '*.ts', instructions: ['TS rule'] }] },
      { instructions: [], rules: [{ glob: '*.vue', instructions: ['Vue rule'] }] },
    ])
    expect(merged.rules).toHaveLength(2)
  })
})
