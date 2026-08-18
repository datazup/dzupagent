import { describe, expect, it } from 'vitest'
import { parseAgentsMd } from '../instructions/agents-md-parser.js'
import { mergeInstructions } from '../instructions/instruction-merger.js'

const STATIC_INSTRUCTIONS = 'Static instructions only.'

function mergeForHeading(heading: string, callerId: string) {
  const sections = parseAgentsMd(`# ${heading}\nInstructions: Apply ${heading} guidance.`)
  return mergeInstructions(STATIC_INSTRUCTIONS, sections, callerId)
}

describe('instruction ID normalization admission', () => {
  it('keeps canonical kebab-case lookup compatible', () => {
    const result = mergeForHeading('CodeReviewer', 'code-reviewer')

    expect(result.systemPrompt).toContain('### code-reviewer')
    expect(result.systemPrompt).toContain('Apply CodeReviewer guidance.')
  })

  it('matches camelCase caller IDs with parsed headings', () => {
    const result = mergeForHeading('CodeReviewer', 'CodeReviewer')

    expect(result.systemPrompt).toContain('### code-reviewer')
  })

  it('matches acronym-boundary caller IDs with parsed headings', () => {
    const result = mergeForHeading('HTMLParser', 'HTMLParser')

    expect(result.systemPrompt).toContain('### html-parser')
  })

  it('matches spaced caller IDs with parsed headings', () => {
    const result = mergeForHeading('Code Reviewer', 'Code Reviewer')

    expect(result.systemPrompt).toContain('### code-reviewer')
  })

  it('matches punctuation-delimited caller IDs with parsed headings', () => {
    const result = mergeForHeading('Data.Agent', 'Data.Agent')

    expect(result.systemPrompt).toContain('### data-agent')
  })

  it('matches colon-delimited sub-agent IDs with parsed headings', () => {
    const result = mergeForHeading('base:skill', 'base:skill')

    expect(result.systemPrompt).toContain('### base-skill')
  })

  it('uses the same normalized ID while traversing descendants', () => {
    const sections = parseAgentsMd(`# RuntimeTeam
Instructions: Coordinate runtime work.

## HTMLParser
Role: Parser specialist
Instructions: Parse markup safely.

## CSSWriter
Instructions: Write styles.`)

    const result = mergeInstructions(STATIC_INSTRUCTIONS, sections, 'HTMLParser')

    expect(result.systemPrompt).toContain('### runtime-team')
    expect(result.systemPrompt).toContain('### html-parser')
    expect(result.systemPrompt).toContain('Parser specialist')
    expect(result.systemPrompt).not.toContain('### css-writer')
  })

  it.each(['', ':::'])('returns only static instructions when %j normalizes empty', callerId => {
    const result = mergeForHeading('CodeReviewer', callerId)

    expect(result.systemPrompt).toBe(STATIC_INSTRUCTIONS)
  })

  it('returns only static instructions for an unmatched normalized ID', () => {
    const result = mergeForHeading('CodeReviewer', 'ReleaseManager')

    expect(result.systemPrompt).toBe(STATIC_INSTRUCTIONS)
  })

  it('preserves the original hierarchy, sources, and rendering inputs', () => {
    const sections = parseAgentsMd(`# TeamLead
Role: Coordinates the team
Instructions: Preserve parent context.

## ChildAgent
Tools: search, review
Constraints: Never mutate source sections
Instructions: Apply child guidance.`)
    const snapshot = JSON.parse(JSON.stringify(sections))
    const sources = ['/workspace/AGENTS.md']

    const result = mergeInstructions(STATIC_INSTRUCTIONS, sections, 'ChildAgent', sources)

    expect(result.systemPrompt).toContain('### team-lead')
    expect(result.systemPrompt).toContain('### child-agent')
    expect(result.systemPrompt).toContain('**Tools:** search, review')
    expect(result.systemPrompt).toContain('- Never mutate source sections')
    expect(result.agentHierarchy).toBe(sections)
    expect(result.sources).toBe(sources)
    expect(sections).toEqual(snapshot)
  })
})
