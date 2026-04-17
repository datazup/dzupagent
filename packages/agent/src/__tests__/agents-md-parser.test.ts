import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseAgentsMd, mergeAgentsMd, discoverAgentsMdHierarchy, type AgentsMdSection } from '../instructions/agents-md-parser.js'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ===========================================================================
// parseAgentsMd — original tests
// ===========================================================================

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

  // --- New parseAgentsMd tests ---

  it('handles camelCase heading normalization', () => {
    const md = `# HTMLParser
Instructions: Parse HTML`
    const result = parseAgentsMd(md)
    expect(result[0]!.agentId).toBe('html-parser')
  })

  it('handles heading with special characters', () => {
    const md = `# Agent @v2.0 (beta)
Instructions: Test`
    const result = parseAgentsMd(md)
    expect(result[0]!.agentId).toBe('agent-v2-0-beta')
  })

  it('handles single tool in tools list', () => {
    const md = `# Agent
Tools: only_one`
    const result = parseAgentsMd(md)
    expect(result[0]!.tools).toEqual(['only_one'])
  })

  it('handles empty tools field', () => {
    const md = `# Agent
Tools: `
    const result = parseAgentsMd(md)
    expect(result[0]!.tools).toBeUndefined()
  })

  it('handles constraints with leading/trailing whitespace', () => {
    const md = `# Agent
Constraints:  first ,  second  `
    const result = parseAgentsMd(md)
    expect(result[0]!.constraints).toEqual(['first', 'second'])
  })

  it('parses 6-level deep hierarchy', () => {
    const md = `# L1
## L2
### L3
#### L4
##### L5
###### L6
Instructions: Deepest`
    const result = parseAgentsMd(md)
    expect(result).toHaveLength(1)
    let node = result[0]!
    for (let i = 0; i < 5; i++) {
      expect(node.childSections).toHaveLength(1)
      node = node.childSections![0]!
    }
    expect(node.agentId).toBe('l6')
    expect(node.instructions).toBe('Deepest')
  })

  it('handles role field case-insensitively', () => {
    const md = `# Agent
role: lowercase role
Instructions: test`
    const result = parseAgentsMd(md)
    expect(result[0]!.role).toBe('lowercase role')
  })

  it('handles multiple blank lines between sections', () => {
    const md = `# First
Instructions: A



# Second
Instructions: B`
    const result = parseAgentsMd(md)
    expect(result).toHaveLength(2)
    expect(result[0]!.instructions).toBe('A')
    expect(result[1]!.instructions).toBe('B')
  })

  it('handles content that is only whitespace after heading', () => {
    const md = `# Agent


   `
    const result = parseAgentsMd(md)
    expect(result).toHaveLength(1)
    expect(result[0]!.instructions).toBe('')
  })
})

// ===========================================================================
// mergeAgentsMd
// ===========================================================================

describe('mergeAgentsMd', () => {
  it('returns empty array for empty layers', () => {
    expect(mergeAgentsMd([])).toEqual([])
  })

  it('returns single layer unchanged', () => {
    const layer: AgentsMdSection[] = [
      { agentId: 'agent-a', instructions: 'Do A', tools: ['t1'] },
    ]
    const result = mergeAgentsMd([layer])
    expect(result).toEqual(layer)
  })

  it('merges two layers with no conflicts', () => {
    const global: AgentsMdSection[] = [
      { agentId: 'agent-a', instructions: 'Global A' },
    ]
    const project: AgentsMdSection[] = [
      { agentId: 'agent-b', instructions: 'Project B' },
    ]
    const result = mergeAgentsMd([global, project])
    expect(result).toHaveLength(2)
    expect(result.find(s => s.agentId === 'agent-a')!.instructions).toBe('Global A')
    expect(result.find(s => s.agentId === 'agent-b')!.instructions).toBe('Project B')
  })

  it('later layer overrides instructions for same agent ID', () => {
    const global: AgentsMdSection[] = [
      { agentId: 'reviewer', instructions: 'Be strict' },
    ]
    const project: AgentsMdSection[] = [
      { agentId: 'reviewer', instructions: 'Be lenient' },
    ]
    const result = mergeAgentsMd([global, project])
    expect(result).toHaveLength(1)
    expect(result[0]!.instructions).toBe('Be lenient')
  })

  it('later layer overrides role for same agent ID', () => {
    const a: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'test', role: 'Old role' },
    ]
    const b: AgentsMdSection[] = [
      { agentId: 'bot', instructions: '', role: 'New role' },
    ]
    const result = mergeAgentsMd([a, b])
    expect(result[0]!.role).toBe('New role')
  })

  it('preserves earlier instructions when later layer has empty instructions', () => {
    const a: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'Keep me' },
    ]
    const b: AgentsMdSection[] = [
      { agentId: 'bot', instructions: '', role: 'Added role' },
    ]
    const result = mergeAgentsMd([a, b])
    // Empty instructions don't override
    expect(result[0]!.instructions).toBe('Keep me')
    expect(result[0]!.role).toBe('Added role')
  })

  it('merges tools arrays with deduplication', () => {
    const a: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'test', tools: ['read_file', 'search'] },
    ]
    const b: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'test', tools: ['search', 'write_file'] },
    ]
    const result = mergeAgentsMd([a, b])
    expect(result[0]!.tools).toEqual(['read_file', 'search', 'write_file'])
  })

  it('merges constraints arrays with deduplication', () => {
    const a: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'test', constraints: ['no delete', 'no push'] },
    ]
    const b: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'test', constraints: ['no push', 'no reset'] },
    ]
    const result = mergeAgentsMd([a, b])
    expect(result[0]!.constraints).toEqual(['no delete', 'no push', 'no reset'])
  })

  it('adds tools from later layer when earlier has none', () => {
    const a: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'test' },
    ]
    const b: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'test', tools: ['new_tool'] },
    ]
    const result = mergeAgentsMd([a, b])
    expect(result[0]!.tools).toEqual(['new_tool'])
  })

  it('preserves tools from earlier layer when later has none', () => {
    const a: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'test', tools: ['old_tool'] },
    ]
    const b: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'updated' },
    ]
    const result = mergeAgentsMd([a, b])
    expect(result[0]!.tools).toEqual(['old_tool'])
  })

  it('merges three layers with correct precedence', () => {
    const global: AgentsMdSection[] = [
      { agentId: 'dev', instructions: 'Global instructions', role: 'Global dev', tools: ['t1'] },
    ]
    const project: AgentsMdSection[] = [
      { agentId: 'dev', instructions: 'Project instructions', tools: ['t2'] },
    ]
    const dir: AgentsMdSection[] = [
      { agentId: 'dev', instructions: 'Dir instructions', tools: ['t1', 't3'] },
    ]
    const result = mergeAgentsMd([global, project, dir])
    expect(result).toHaveLength(1)
    expect(result[0]!.instructions).toBe('Dir instructions')
    // role from global is preserved since project and dir don't set it
    // Actually project layer sets no role, so the global role should remain from layer a,
    // then b doesn't override (no role), then c doesn't override (no role)
    expect(result[0]!.role).toBe('Global dev')
    expect(result[0]!.tools).toEqual(['t1', 't2', 't3'])
  })

  it('merges child sections across layers', () => {
    const a: AgentsMdSection[] = [
      {
        agentId: 'parent',
        instructions: 'Parent A',
        childSections: [
          { agentId: 'child-1', instructions: 'Child 1 from A' },
        ],
      },
    ]
    const b: AgentsMdSection[] = [
      {
        agentId: 'parent',
        instructions: 'Parent B',
        childSections: [
          { agentId: 'child-1', instructions: 'Child 1 from B' },
          { agentId: 'child-2', instructions: 'Child 2 from B' },
        ],
      },
    ]
    const result = mergeAgentsMd([a, b])
    expect(result).toHaveLength(1)
    expect(result[0]!.childSections).toHaveLength(2)
    expect(result[0]!.childSections![0]!.agentId).toBe('child-1')
    expect(result[0]!.childSections![0]!.instructions).toBe('Child 1 from B')
    expect(result[0]!.childSections![1]!.agentId).toBe('child-2')
  })

  it('adds child sections from later layer when earlier has none', () => {
    const a: AgentsMdSection[] = [
      { agentId: 'parent', instructions: 'Parent' },
    ]
    const b: AgentsMdSection[] = [
      {
        agentId: 'parent',
        instructions: 'Parent',
        childSections: [{ agentId: 'child', instructions: 'New child' }],
      },
    ]
    const result = mergeAgentsMd([a, b])
    expect(result[0]!.childSections).toHaveLength(1)
    expect(result[0]!.childSections![0]!.agentId).toBe('child')
  })

  it('does not mutate input layers', () => {
    const a: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'orig', tools: ['t1'] },
    ]
    const b: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'new', tools: ['t2'] },
    ]
    mergeAgentsMd([a, b])
    expect(a[0]!.tools).toEqual(['t1'])
    expect(a[0]!.instructions).toBe('orig')
    expect(b[0]!.tools).toEqual(['t2'])
  })

  it('handles layers with empty arrays', () => {
    const result = mergeAgentsMd([[], []])
    expect(result).toEqual([])
  })

  it('handles one empty layer and one populated layer', () => {
    const populated: AgentsMdSection[] = [
      { agentId: 'bot', instructions: 'hello' },
    ]
    const result = mergeAgentsMd([[], populated])
    expect(result).toHaveLength(1)
    expect(result[0]!.agentId).toBe('bot')
  })

  it('preserves order: earlier agents come first, new agents appended', () => {
    const a: AgentsMdSection[] = [
      { agentId: 'alpha', instructions: 'A' },
      { agentId: 'beta', instructions: 'B' },
    ]
    const b: AgentsMdSection[] = [
      { agentId: 'gamma', instructions: 'C' },
      { agentId: 'alpha', instructions: 'A updated' },
    ]
    const result = mergeAgentsMd([a, b])
    expect(result.map(s => s.agentId)).toEqual(['alpha', 'beta', 'gamma'])
    expect(result[0]!.instructions).toBe('A updated')
  })

  it('handles many agents across many layers', () => {
    const layers: AgentsMdSection[][] = Array.from({ length: 5 }, (_, i) => [
      { agentId: `agent-${i}`, instructions: `Layer ${i}` },
    ])
    const result = mergeAgentsMd(layers)
    expect(result).toHaveLength(5)
  })

  it('merges tools from child sections across layers', () => {
    const a: AgentsMdSection[] = [
      {
        agentId: 'parent',
        instructions: 'P',
        childSections: [
          { agentId: 'child', instructions: 'C', tools: ['tool-a'] },
        ],
      },
    ]
    const b: AgentsMdSection[] = [
      {
        agentId: 'parent',
        instructions: 'P',
        childSections: [
          { agentId: 'child', instructions: 'C updated', tools: ['tool-a', 'tool-b'] },
        ],
      },
    ]
    const result = mergeAgentsMd([a, b])
    expect(result[0]!.childSections![0]!.tools).toEqual(['tool-a', 'tool-b'])
  })
})

// ===========================================================================
// mergeAgentsMd integration with parseAgentsMd
// ===========================================================================

describe('mergeAgentsMd with parsed content', () => {
  it('merges two parsed AGENTS.md contents', () => {
    const global = parseAgentsMd(`# Reviewer
Role: Code reviewer
Tools: read_file`)

    const project = parseAgentsMd(`# Reviewer
Instructions: Focus on security
Tools: search_code`)

    const result = mergeAgentsMd([global, project])
    expect(result).toHaveLength(1)
    expect(result[0]!.instructions).toBe('Focus on security')
    expect(result[0]!.tools).toEqual(['read_file', 'search_code'])
  })

  it('merges three parsed AGENTS.md with directory-level override', () => {
    const global = parseAgentsMd(`# Coder
Role: Writes code
Constraints: follow style guide`)

    const project = parseAgentsMd(`# Coder
Tools: write_file, read_file
Constraints: max 500 lines`)

    const dir = parseAgentsMd(`# Coder
Instructions: Only write TypeScript
Constraints: follow style guide, use strict mode`)

    const result = mergeAgentsMd([global, project, dir])
    expect(result).toHaveLength(1)
    expect(result[0]!.instructions).toBe('Only write TypeScript')
    expect(result[0]!.role).toBe('Writes code')
    expect(result[0]!.tools).toEqual(['write_file', 'read_file'])
    expect(result[0]!.constraints).toEqual(['follow style guide', 'max 500 lines', 'use strict mode'])
  })

  it('merges layers with disjoint agents', () => {
    const a = parseAgentsMd(`# Builder
Instructions: Build things`)

    const b = parseAgentsMd(`# Tester
Instructions: Test things`)

    const result = mergeAgentsMd([a, b])
    expect(result).toHaveLength(2)
    expect(result.find(s => s.agentId === 'builder')).toBeDefined()
    expect(result.find(s => s.agentId === 'tester')).toBeDefined()
  })
})

// ===========================================================================
// Malformed input handling
// ===========================================================================

describe('parseAgentsMd malformed input', () => {
  it('handles heading with no text after hashes', () => {
    // This won't match the regex since it requires at least one char after space
    const md = `#
Instructions: orphan`
    const result = parseAgentsMd(md)
    // The heading regex requires non-empty text, so this is just body text
    expect(result).toEqual([])
  })

  it('handles content with only headings, no body', () => {
    const md = `# A
# B
# C`
    const result = parseAgentsMd(md)
    expect(result).toHaveLength(3)
    expect(result.every(s => s.instructions === '')).toBe(true)
  })

  it('handles extremely long single line', () => {
    const longLine = 'x'.repeat(10000)
    const md = `# Agent
Instructions: ${longLine}`
    const result = parseAgentsMd(md)
    expect(result[0]!.instructions).toBe(longLine)
  })

  it('handles windows-style line endings after normalization', () => {
    // The parser regex `$` does not match before \r, so CRLF must be
    // pre-normalized. This test verifies that content with \r\n works
    // after a simple replace.
    const raw = '# Agent\r\nRole: Test role\r\nInstructions: Test\r\nTools: a, b'
    const md = raw.replace(/\r\n/g, '\n')
    const result = parseAgentsMd(md)
    expect(result).toHaveLength(1)
    expect(result[0]!.agentId).toBe('agent')
    expect(result[0]!.role).toBe('Test role')
  })

  it('handles duplicate field names (first wins)', () => {
    const md = `# Agent
Role: First role
Role: Second role
Instructions: test`
    const result = parseAgentsMd(md)
    expect(result[0]!.role).toBe('First role')
  })

  it('handles a heading that looks like a field name', () => {
    const md = `# Role
Instructions: I am named Role`
    const result = parseAgentsMd(md)
    expect(result[0]!.agentId).toBe('role')
    expect(result[0]!.instructions).toBe('I am named Role')
  })

  it('handles unicode in heading', () => {
    const md = `# Agente Espa\u00f1ol
Instructions: Hola`
    const result = parseAgentsMd(md)
    expect(result).toHaveLength(1)
    expect(result[0]!.instructions).toBe('Hola')
  })

  it('treats tab-indented field lines partially', () => {
    // extractField uses `^FieldName:` with `m` flag — tabs before the field
    // name prevent matching. The fallback instruction extractor trims and
    // filters known fields (Role, Tools, Constraints), so Role is filtered.
    // But "Instructions: also tabbed" remains as body text since it's not
    // in the filter list and extractField('Instructions') also failed.
    const md = `# Agent
\tRole: tabbed
\tInstructions: also tabbed`
    const result = parseAgentsMd(md)
    expect(result).toHaveLength(1)
    expect(result[0]!.role).toBeUndefined()
    expect(result[0]!.instructions).toBe('Instructions: also tabbed')
  })
})

// ===========================================================================
// discoverAgentsMdHierarchy
// ===========================================================================

describe('discoverAgentsMdHierarchy', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'agents-md-test-'))
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('returns empty array when no AGENTS.md files exist', async () => {
    const result = await discoverAgentsMdHierarchy(tmpRoot)
    expect(result).toEqual([])
  })

  it('discovers AGENTS.md in cwd', async () => {
    await writeFile(join(tmpRoot, 'AGENTS.md'), `# Agent
Instructions: From cwd`)
    const result = await discoverAgentsMdHierarchy(tmpRoot)
    expect(result).toHaveLength(1)
    expect(result[0]![0]!.agentId).toBe('agent')
  })

  it('discovers AGENTS.md in global dir', async () => {
    const globalDir = join(tmpRoot, 'global')
    await mkdir(globalDir, { recursive: true })
    await writeFile(join(globalDir, 'AGENTS.md'), `# GlobalAgent
Instructions: Global config`)

    const cwd = join(tmpRoot, 'project')
    await mkdir(cwd, { recursive: true })

    const result = await discoverAgentsMdHierarchy(cwd, globalDir)
    expect(result).toHaveLength(1)
    expect(result[0]![0]!.agentId).toBe('global-agent')
  })

  it('discovers hierarchy: global then cwd', async () => {
    const globalDir = join(tmpRoot, 'global')
    await mkdir(globalDir, { recursive: true })
    await writeFile(join(globalDir, 'AGENTS.md'), `# Agent
Role: Global role`)

    await writeFile(join(tmpRoot, 'AGENTS.md'), `# Agent
Instructions: Project instructions`)

    const result = await discoverAgentsMdHierarchy(tmpRoot, globalDir)
    expect(result.length).toBeGreaterThanOrEqual(2)

    // Global should come before cwd
    const globalLayer = result[0]!
    expect(globalLayer[0]!.role).toBe('Global role')
  })

  it('discovers intermediate directories between root and cwd', async () => {
    const projectDir = join(tmpRoot, 'project')
    const subDir = join(projectDir, 'src', 'components')
    await mkdir(subDir, { recursive: true })

    await writeFile(join(projectDir, 'AGENTS.md'), `# Agent
Instructions: Project level`)

    await writeFile(join(subDir, 'AGENTS.md'), `# Agent
Instructions: Component level`)

    const result = await discoverAgentsMdHierarchy(subDir)
    // Should find both project and subDir AGENTS.md files
    const instructions = result.map(layer => layer[0]!.instructions)
    expect(instructions).toContain('Project level')
    expect(instructions).toContain('Component level')
  })

  it('silently skips missing global dir', async () => {
    const result = await discoverAgentsMdHierarchy(tmpRoot, '/nonexistent/path/abc123')
    // Should not throw
    expect(Array.isArray(result)).toBe(true)
  })

  it('handles cwd that does not exist', async () => {
    const result = await discoverAgentsMdHierarchy(join(tmpRoot, 'does-not-exist'))
    // Should not throw, just returns whatever was found
    expect(Array.isArray(result)).toBe(true)
  })

  it('does not duplicate global dir if it is an ancestor of cwd', async () => {
    // globalDir IS the tmpRoot, and cwd is a child
    const cwd = join(tmpRoot, 'child')
    await mkdir(cwd, { recursive: true })
    await writeFile(join(tmpRoot, 'AGENTS.md'), `# Agent
Instructions: Root agent`)

    const result = await discoverAgentsMdHierarchy(cwd, tmpRoot)
    // Should only appear once
    const rootAgentLayers = result.filter(layer =>
      layer.some(s => s.instructions === 'Root agent'),
    )
    expect(rootAgentLayers).toHaveLength(1)
  })

  it('returns layers in correct order for merge (global first, cwd last)', async () => {
    const globalDir = join(tmpRoot, 'global')
    const projectDir = join(tmpRoot, 'project')
    const subDir = join(projectDir, 'sub')

    await mkdir(globalDir, { recursive: true })
    await mkdir(subDir, { recursive: true })

    await writeFile(join(globalDir, 'AGENTS.md'), `# Agent
Role: Global`)
    await writeFile(join(projectDir, 'AGENTS.md'), `# Agent
Role: Project`)
    await writeFile(join(subDir, 'AGENTS.md'), `# Agent
Role: SubDir`)

    const result = await discoverAgentsMdHierarchy(subDir, globalDir)
    expect(result.length).toBeGreaterThanOrEqual(3)

    // First layer should be global
    expect(result[0]![0]!.role).toBe('Global')

    // Last layer should be subDir
    const lastLayer = result[result.length - 1]!
    expect(lastLayer[0]!.role).toBe('SubDir')
  })

  it('works end-to-end: discover + merge', async () => {
    const globalDir = join(tmpRoot, 'global')
    const projectDir = join(tmpRoot, 'project')
    await mkdir(globalDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })

    await writeFile(join(globalDir, 'AGENTS.md'), `# Coder
Role: Code writer
Tools: read_file
Constraints: be safe`)

    await writeFile(join(projectDir, 'AGENTS.md'), `# Coder
Instructions: Write TypeScript only
Tools: write_file
Constraints: use strict mode`)

    const layers = await discoverAgentsMdHierarchy(projectDir, globalDir)
    const merged = mergeAgentsMd(layers)

    expect(merged).toHaveLength(1)
    expect(merged[0]!.instructions).toBe('Write TypeScript only')
    expect(merged[0]!.role).toBe('Code writer')
    expect(merged[0]!.tools).toContain('read_file')
    expect(merged[0]!.tools).toContain('write_file')
    expect(merged[0]!.constraints).toContain('be safe')
    expect(merged[0]!.constraints).toContain('use strict mode')
  })

  it('handles malformed AGENTS.md file gracefully', async () => {
    await writeFile(join(tmpRoot, 'AGENTS.md'), 'This has no headings at all, just text.')
    const result = await discoverAgentsMdHierarchy(tmpRoot)
    // No headings means empty parse result, so no layers
    expect(result).toEqual([])
  })

  it('handles AGENTS.md with only whitespace', async () => {
    await writeFile(join(tmpRoot, 'AGENTS.md'), '   \n\n  ')
    const result = await discoverAgentsMdHierarchy(tmpRoot)
    expect(result).toEqual([])
  })
})
