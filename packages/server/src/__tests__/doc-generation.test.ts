import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderAgentDoc } from '../docs/agent-doc.js'
import { renderToolDoc } from '../docs/tool-doc.js'
import { renderPipelineDoc } from '../docs/pipeline-doc.js'
import { DocGenerator } from '../docs/doc-generator.js'

// Mock fs/promises for DocGenerator tests
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
}))

describe('renderAgentDoc', () => {
  it('produces markdown with agent name and description', () => {
    const md = renderAgentDoc({ name: 'CodeBot', description: 'Writes code.' })
    expect(md).toContain('# Agent: CodeBot')
    expect(md).toContain('Writes code.')
  })

  it('includes tools list when provided', () => {
    const md = renderAgentDoc({
      name: 'Bot',
      description: 'desc',
      tools: ['git_status', 'file_write'],
    })
    expect(md).toContain('## Tools')
    expect(md).toContain('`git_status`')
    expect(md).toContain('`file_write`')
  })

  it('includes instructions when provided', () => {
    const md = renderAgentDoc({
      name: 'Bot',
      description: 'desc',
      instructions: 'Always be concise.',
    })
    expect(md).toContain('## Instructions')
    expect(md).toContain('Always be concise.')
  })

  it('includes guardrails table when provided', () => {
    const md = renderAgentDoc({
      name: 'Bot',
      description: 'desc',
      guardrails: { maxTokens: 4096, allowDelete: false },
    })
    expect(md).toContain('## Guardrails')
    expect(md).toContain('maxTokens')
    expect(md).toContain('4096')
    expect(md).toContain('allowDelete')
  })

  it('omits optional sections when not provided', () => {
    const md = renderAgentDoc({ name: 'Bot', description: 'desc' })
    expect(md).not.toContain('## Tools')
    expect(md).not.toContain('## Instructions')
    expect(md).not.toContain('## Guardrails')
  })
})

describe('renderToolDoc', () => {
  it('produces markdown with tool name and description', () => {
    const md = renderToolDoc({ name: 'search', description: 'Searches things.' })
    expect(md).toContain('# Tool: search')
    expect(md).toContain('Searches things.')
  })

  it('produces parameter table from JSON Schema', () => {
    const md = renderToolDoc({
      name: 'search',
      description: 'Searches things.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'The search query' },
          limit: { type: 'number', description: 'Max results' },
        },
      },
    })
    expect(md).toContain('## Parameters')
    expect(md).toContain('| Parameter | Type | Required | Description |')
    expect(md).toContain('`query`')
    expect(md).toContain('string')
    expect(md).toContain('Yes')
    expect(md).toContain('The search query')
    expect(md).toContain('`limit`')
    expect(md).toContain('No')
  })

  it('omits parameter table when no input schema', () => {
    const md = renderToolDoc({ name: 'ping', description: 'Pings.' })
    expect(md).not.toContain('## Parameters')
  })
})

describe('renderPipelineDoc', () => {
  const pipeline = {
    name: 'deploy',
    definition: {
      nodes: [
        { id: 'build', type: 'tool', name: 'Build Step' },
        { id: 'test', type: 'tool', name: 'Test Step' },
        { id: 'deploy', type: 'agent', name: 'Deploy Agent' },
      ],
      edges: [
        { type: 'sequential', sourceNodeId: 'build', targetNodeId: 'test' },
        { type: 'sequential', sourceNodeId: 'test', targetNodeId: 'deploy' },
      ],
    },
  }

  it('produces a Mermaid flowchart', () => {
    const md = renderPipelineDoc(pipeline)
    expect(md).toContain('# Pipeline: deploy')
    expect(md).toContain('```mermaid')
    expect(md).toContain('flowchart TD')
    expect(md).toContain('build["Build Step"]')
    expect(md).toContain('build --> test')
    expect(md).toContain('test --> deploy')
  })

  it('includes a node table', () => {
    const md = renderPipelineDoc(pipeline)
    expect(md).toContain('## Nodes')
    expect(md).toContain('| build | tool | Build Step |')
  })

  it('renders conditional edges with labels', () => {
    const md = renderPipelineDoc({
      name: 'branch',
      definition: {
        nodes: [
          { id: 'gate', type: 'gate' },
          { id: 'pass', type: 'tool' },
          { id: 'fail', type: 'tool' },
        ],
        edges: [
          {
            type: 'conditional',
            sourceNodeId: 'gate',
            branches: { approved: 'pass', rejected: 'fail' },
          },
        ],
      },
    })
    expect(md).toContain('gate -->|approved| pass')
    expect(md).toContain('gate -->|rejected| fail')
  })
})

describe('DocGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('generates multiple doc files and returns paths', async () => {
    const gen = new DocGenerator({ outputDir: '/tmp/docs' })

    const paths = await gen.generate({
      agents: [{ name: 'Bot', description: 'A bot.' }],
      tools: [{ name: 'search', description: 'Search.' }],
      pipelines: [
        {
          name: 'ci',
          definition: {
            nodes: [{ id: 'n1', type: 'tool' }],
            edges: [],
          },
        },
      ],
    })

    expect(paths).toHaveLength(3)
    expect(paths[0]).toContain('agent-bot')
    expect(paths[1]).toContain('tool-search')
    expect(paths[2]).toContain('pipeline-ci')
  })

  it('filters by include list', async () => {
    const gen = new DocGenerator({ outputDir: '/tmp/docs', include: ['Bot'] })

    const paths = await gen.generate({
      agents: [
        { name: 'Bot', description: 'A bot.' },
        { name: 'Other', description: 'Other.' },
      ],
    })

    expect(paths).toHaveLength(1)
    expect(paths[0]).toContain('agent-bot')
  })

  it('generates HTML when format is html', async () => {
    const gen = new DocGenerator({ outputDir: '/tmp/docs', format: 'html' })

    const paths = await gen.generate({
      agents: [{ name: 'Bot', description: 'A bot.' }],
    })

    expect(paths).toHaveLength(1)
    expect(paths[0]).toContain('.html')
  })

  it('handles empty context gracefully', async () => {
    const gen = new DocGenerator({ outputDir: '/tmp/docs' })
    const paths = await gen.generate({})
    expect(paths).toHaveLength(0)
  })
})
