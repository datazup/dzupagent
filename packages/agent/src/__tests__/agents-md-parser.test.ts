import { describe, it, expect } from 'vitest'
import { parseAgentsMd, type AgentsMdSection } from '../instructions/agents-md-parser.js'

describe('parseAgentsMd', () => {
  it('returns empty array for empty input', () => {
    expect(parseAgentsMd('')).toEqual([])
    expect(parseAgentsMd('   \n  \n  ')).toEqual([])
  })

  it('parses a single top-level agent section', () => {
    const md = `# CodeReviewer
Role: Reviews pull requests
Instructions: Focus on logic errors and security issues.
Tools: read_file, search_code
Constraints: Never modify files directly, Stay within scope`

    const result = parseAgentsMd(md)

    expect(result).toHaveLength(1)
    expect(result[0]!.agentId).toBe('code-reviewer')
    expect(result[0]!.role).toBe('Reviews pull requests')
    expect(result[0]!.instructions).toBe('Focus on logic errors and security issues.')
    expect(result[0]!.tools).toEqual(['read_file', 'search_code'])
    expect(result[0]!.constraints).toEqual(['Never modify files directly', 'Stay within scope'])
  })

  it('parses multiple top-level sections', () => {
    const md = `# Planner
Role: Plans tasks
Instructions: Break down complex requests.

# Executor
Role: Executes plans
Instructions: Follow the plan step by step.`

    const result = parseAgentsMd(md)

    expect(result).toHaveLength(2)
    expect(result[0]!.agentId).toBe('planner')
    expect(result[1]!.agentId).toBe('executor')
  })

  it('parses nested child sections', () => {
    const md = `# TeamLead
Role: Manages the team
Instructions: Coordinate sub-agents.

## BackendDev
Role: Backend development
Instructions: Write server-side code.

## FrontendDev
Role: Frontend development
Instructions: Write client-side code.

### StyleChecker
Instructions: Enforce CSS conventions.`

    const result = parseAgentsMd(md)

    expect(result).toHaveLength(1)
    const lead = result[0]!
    expect(lead.agentId).toBe('team-lead')
    expect(lead.childSections).toHaveLength(2)

    const backend = lead.childSections![0]!
    expect(backend.agentId).toBe('backend-dev')
    expect(backend.childSections).toBeUndefined()

    const frontend = lead.childSections![1]!
    expect(frontend.agentId).toBe('frontend-dev')
    expect(frontend.childSections).toHaveLength(1)
    expect(frontend.childSections![0]!.agentId).toBe('style-checker')
  })

  it('uses remaining body text as instructions when no explicit Instructions: field', () => {
    const md = `# Helper
Role: General helper

Focus on being helpful and accurate.
Always verify your work.`

    const result = parseAgentsMd(md)

    expect(result).toHaveLength(1)
    expect(result[0]!.instructions).toContain('Focus on being helpful')
    expect(result[0]!.instructions).toContain('Always verify your work')
    // Should not include the Role line
    expect(result[0]!.instructions).not.toContain('General helper')
  })

  it('normalises heading to kebab-case agentId', () => {
    const md = `# My Fancy Agent 2000
Instructions: Test`

    const result = parseAgentsMd(md)
    expect(result[0]!.agentId).toBe('my-fancy-agent-2000')
  })

  it('ignores text before the first heading', () => {
    const md = `This is a preamble that should be ignored.

# Agent
Instructions: Real content here.`

    const result = parseAgentsMd(md)
    expect(result).toHaveLength(1)
    expect(result[0]!.agentId).toBe('agent')
    expect(result[0]!.instructions).toBe('Real content here.')
  })

  it('handles section without any fields', () => {
    const md = `# EmptyAgent`

    const result = parseAgentsMd(md)
    expect(result).toHaveLength(1)
    expect(result[0]!.agentId).toBe('empty-agent')
    expect(result[0]!.instructions).toBe('')
    expect(result[0]!.role).toBeUndefined()
    expect(result[0]!.tools).toBeUndefined()
    expect(result[0]!.constraints).toBeUndefined()
  })

  it('handles deeply nested hierarchy (3 levels)', () => {
    const md = `# Root
Instructions: Root level

## Mid
Instructions: Mid level

### Leaf
Instructions: Leaf level`

    const result = parseAgentsMd(md)
    expect(result).toHaveLength(1)
    expect(result[0]!.childSections).toHaveLength(1)
    expect(result[0]!.childSections![0]!.childSections).toHaveLength(1)
    expect(result[0]!.childSections![0]!.childSections![0]!.agentId).toBe('leaf')
  })

  it('handles sibling sections at same depth after nested ones', () => {
    const md = `# A
## A1
## A2
# B
## B1`

    const result = parseAgentsMd(md)
    expect(result).toHaveLength(2)
    expect(result[0]!.agentId).toBe('a')
    expect(result[0]!.childSections).toHaveLength(2)
    expect(result[1]!.agentId).toBe('b')
    expect(result[1]!.childSections).toHaveLength(1)
  })
})
