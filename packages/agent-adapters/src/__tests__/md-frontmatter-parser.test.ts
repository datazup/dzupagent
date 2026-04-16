import { describe, expect, it } from 'vitest'
import { parseMarkdownFile } from '../dzupagent/md-frontmatter-parser.js'

describe('parseMarkdownFile', () => {
  it('parses a complete skill frontmatter', () => {
    const content = `---
name: code-reviewer
description: Expert code review
version: 2
owner: platform-team
constraints:
  maxBudgetUsd: 0.50
  approvalMode: auto
  networkPolicy: restricted
  toolPolicy: balanced
tools:
  required: [read_file, search_files]
  optional: [run_tests]
  blocked: [exec_command]
---

## Persona
You are a senior engineer.

## Task
Review the code for correctness.
`
    const result = parseMarkdownFile(content)

    expect(result.frontmatter['name']).toBe('code-reviewer')
    expect(result.frontmatter['description']).toBe('Expert code review')
    expect(result.frontmatter['version']).toBe(2)
    expect(result.frontmatter['owner']).toBe('platform-team')

    const constraints = result.frontmatter['constraints'] as Record<string, unknown>
    expect(constraints['maxBudgetUsd']).toBe(0.5)
    expect(constraints['approvalMode']).toBe('auto')
    expect(constraints['networkPolicy']).toBe('restricted')
    expect(constraints['toolPolicy']).toBe('balanced')

    const tools = result.frontmatter['tools'] as Record<string, unknown>
    expect(tools['required']).toEqual(['read_file', 'search_files'])
    expect(tools['optional']).toEqual(['run_tests'])
    expect(tools['blocked']).toEqual(['exec_command'])
  })

  it('parses ## heading sections', () => {
    const content = `---
name: my-skill
---

## Persona
You are an expert.

## Task
Do the thing.

## Output
Return JSON.
`
    const result = parseMarkdownFile(content)
    expect(result.sections).toHaveLength(3)
    expect(result.sections[0]!.heading).toBe('Persona')
    expect(result.sections[0]!.content).toBe('You are an expert.')
    expect(result.sections[1]!.heading).toBe('Task')
    expect(result.sections[2]!.heading).toBe('Output')
  })

  it('handles file with no frontmatter', () => {
    const content = `# Just a markdown file\n\nSome content here.`
    const result = parseMarkdownFile(content)
    expect(result.frontmatter).toEqual({})
    expect(result.rawBody).toContain('Just a markdown file')
  })

  it('handles file with frontmatter but no sections', () => {
    const content = `---
name: minimal
---

Just some instructions without headings.
`
    const result = parseMarkdownFile(content)
    expect(result.frontmatter['name']).toBe('minimal')
    expect(result.sections).toHaveLength(0)
    expect(result.rawBody).toContain('Just some instructions')
  })

  it('parses boolean values', () => {
    const content = `---
active: true
disabled: false
---
`
    const result = parseMarkdownFile(content)
    expect(result.frontmatter['active']).toBe(true)
    expect(result.frontmatter['disabled']).toBe(false)
  })

  it('parses inline arrays', () => {
    const content = `---
tags: [code, review, security]
---
`
    const result = parseMarkdownFile(content)
    expect(result.frontmatter['tags']).toEqual(['code', 'review', 'security'])
  })

  it('handles empty inline array', () => {
    const content = `---
blocked: []
---
`
    const result = parseMarkdownFile(content)
    expect(result.frontmatter['blocked']).toEqual([])
  })

  it('trims section content correctly', () => {
    const content = `---
name: test
---

## Task

  Some content with leading whitespace.

More content.

## Output
Result here.
`
    const result = parseMarkdownFile(content)
    const task = result.sections.find((s) => s.heading === 'Task')
    expect(task).toBeDefined()
    expect(task!.content).toBe('Some content with leading whitespace.\n\nMore content.')
  })
})
