import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  AgentCardV2Schema,
  validateAgentCard,
} from '../agent-card-types.js'
import {
  zodToJsonSchema,
  jsonSchemaToZod,
  toOpenAIFunction,
  toOpenAITool,
  fromOpenAIFunction,
  toMCPToolDescriptor,
  fromMCPToolDescriptor,
} from '../tool-format-adapters.js'
import type { ToolSchemaDescriptor } from '../tool-format-adapters.js'
import type { OpenAIFunctionDefinition } from '../openai-function-types.js'
import { parseAgentsMdV2, generateAgentsMd, toLegacyConfig } from '../agents-md-parser-v2.js'

// =========================================================================
// Agent Card V2 validation
// =========================================================================

describe('AgentCardV2Schema', () => {
  const validCard = {
    name: 'TestAgent',
    description: 'A test agent',
    url: 'https://example.com/agent',
    version: '1.0.0',
    provider: { organization: 'TestCo', url: 'https://testco.com' },
    capabilities: [
      {
        name: 'code-review',
        description: 'Reviews code for issues',
        inputSchema: { type: 'object', properties: { code: { type: 'string' } } },
      },
    ],
    skills: [
      { id: 'skill-1', name: 'Linting', description: 'Lint code', tags: ['code', 'quality'] },
    ],
    authentication: {
      schemes: [{ type: 'bearer' as const }],
    },
    defaultInputModes: ['text' as const],
    defaultOutputModes: ['text' as const, 'file' as const],
    sla: { maxLatencyMs: 5000, maxCostCents: 10, uptimeRatio: 0.99 },
    metadata: { custom: 'value' },
  }

  it('validates a fully populated agent card', () => {
    const result = AgentCardV2Schema.safeParse(validCard)
    expect(result.success).toBe(true)
  })

  it('validates a minimal agent card', () => {
    const result = AgentCardV2Schema.safeParse({
      name: 'Min',
      description: 'Minimal',
      url: 'https://example.com',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a card with missing required fields', () => {
    const result = AgentCardV2Schema.safeParse({ name: 'NoUrl' })
    expect(result.success).toBe(false)
  })

  it('rejects a card with invalid URL', () => {
    const result = AgentCardV2Schema.safeParse({
      name: 'Bad',
      description: 'Bad url',
      url: 'not-a-url',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid content mode', () => {
    const result = AgentCardV2Schema.safeParse({
      name: 'Bad',
      description: 'Bad mode',
      url: 'https://example.com',
      defaultInputModes: ['hologram'],
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid SLA uptimeRatio > 1', () => {
    const result = AgentCardV2Schema.safeParse({
      name: 'Bad',
      description: 'Bad sla',
      url: 'https://example.com',
      sla: { uptimeRatio: 1.5 },
    })
    expect(result.success).toBe(false)
  })
})

describe('validateAgentCard', () => {
  it('returns valid: true with parsed card on success', () => {
    const result = validateAgentCard({
      name: 'Agent',
      description: 'Desc',
      url: 'https://example.com',
    })
    expect(result.valid).toBe(true)
    expect(result.card).toBeDefined()
    expect(result.card!.name).toBe('Agent')
    expect(result.errors).toBeUndefined()
  })

  it('returns valid: false with error messages on failure', () => {
    const result = validateAgentCard({ name: '' })
    expect(result.valid).toBe(false)
    expect(result.errors).toBeDefined()
    expect(result.errors!.length).toBeGreaterThan(0)
  })
})

// =========================================================================
// zodToJsonSchema
// =========================================================================

describe('zodToJsonSchema', () => {
  it('converts z.object with string/number/boolean fields', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
    })
    const json = zodToJsonSchema(schema)

    expect(json).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
        active: { type: 'boolean' },
      },
      required: ['name', 'age', 'active'],
    })
  })

  it('handles optional fields', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    })
    const json = zodToJsonSchema(schema)

    expect(json['required']).toEqual(['required'])
    const props = json['properties'] as Record<string, unknown>
    expect(props['optional']).toEqual({ type: 'string' })
  })

  it('converts z.array', () => {
    const schema = z.object({
      tags: z.array(z.string()),
    })
    const json = zodToJsonSchema(schema)
    const props = json['properties'] as Record<string, Record<string, unknown>>
    expect(props['tags']).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('converts z.enum', () => {
    const schema = z.object({
      status: z.enum(['active', 'inactive', 'pending']),
    })
    const json = zodToJsonSchema(schema)
    const props = json['properties'] as Record<string, Record<string, unknown>>
    expect(props['status']).toEqual({
      type: 'string',
      enum: ['active', 'inactive', 'pending'],
    })
  })

  it('handles nested objects', () => {
    const schema = z.object({
      nested: z.object({
        value: z.number(),
      }),
    })
    const json = zodToJsonSchema(schema)
    const props = json['properties'] as Record<string, Record<string, unknown>>
    expect(props['nested']).toEqual({
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    })
  })
})

// =========================================================================
// jsonSchemaToZod
// =========================================================================

describe('jsonSchemaToZod', () => {
  it('converts basic types', () => {
    const strSchema = jsonSchemaToZod({ type: 'string' })
    expect(strSchema.safeParse('hello').success).toBe(true)
    expect(strSchema.safeParse(123).success).toBe(false)

    const numSchema = jsonSchemaToZod({ type: 'number' })
    expect(numSchema.safeParse(42).success).toBe(true)

    const boolSchema = jsonSchemaToZod({ type: 'boolean' })
    expect(boolSchema.safeParse(true).success).toBe(true)
  })

  it('converts integer to z.number', () => {
    const schema = jsonSchemaToZod({ type: 'integer' })
    expect(schema.safeParse(42).success).toBe(true)
  })

  it('converts arrays', () => {
    const schema = jsonSchemaToZod({
      type: 'array',
      items: { type: 'string' },
    })
    expect(schema.safeParse(['a', 'b']).success).toBe(true)
    expect(schema.safeParse([1, 2]).success).toBe(false)
  })

  it('converts objects with required fields', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    })
    expect(schema.safeParse({ name: 'Alice' }).success).toBe(true)
    expect(schema.safeParse({ age: 30 }).success).toBe(false) // name is required
    expect(schema.safeParse({ name: 'Alice', age: 30 }).success).toBe(true)
  })

  it('converts enum', () => {
    const schema = jsonSchemaToZod({
      type: 'string',
      enum: ['a', 'b', 'c'],
    })
    expect(schema.safeParse('a').success).toBe(true)
    expect(schema.safeParse('d').success).toBe(false)
  })
})

describe('zodToJsonSchema + jsonSchemaToZod round-trip', () => {
  it('round-trips a complex object schema', () => {
    const original = z.object({
      name: z.string(),
      count: z.number(),
      tags: z.array(z.string()),
      status: z.enum(['active', 'inactive']),
    })

    const jsonSchema = zodToJsonSchema(original)
    const roundTripped = jsonSchemaToZod(jsonSchema)

    const testData = { name: 'test', count: 5, tags: ['a'], status: 'active' }
    expect(roundTripped.safeParse(testData).success).toBe(true)

    const badData = { name: 'test', count: 'not-a-number', tags: ['a'], status: 'active' }
    expect(roundTripped.safeParse(badData).success).toBe(false)
  })
})

// =========================================================================
// OpenAI adapters
// =========================================================================

describe('toOpenAIFunction / fromOpenAIFunction', () => {
  const tool: ToolSchemaDescriptor = {
    name: 'search',
    description: 'Search for items',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: { results: { type: 'array' } },
    },
  }

  it('converts to OpenAI function definition', () => {
    const fn = toOpenAIFunction(tool)
    expect(fn.name).toBe('search')
    expect(fn.description).toBe('Search for items')
    expect(fn.parameters).toEqual(tool.inputSchema)
  })

  it('round-trips through OpenAI format', () => {
    const fn = toOpenAIFunction(tool)
    const back = fromOpenAIFunction(fn)
    expect(back.name).toBe(tool.name)
    expect(back.description).toBe(tool.description)
    expect(back.inputSchema).toEqual(tool.inputSchema)
  })

  it('handles missing description in fromOpenAIFunction', () => {
    const fn: OpenAIFunctionDefinition = {
      name: 'test',
      parameters: { type: 'object' },
    }
    const back = fromOpenAIFunction(fn)
    expect(back.description).toBe('')
  })
})

describe('toOpenAITool', () => {
  it('wraps function in tool definition', () => {
    const tool: ToolSchemaDescriptor = {
      name: 'read',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    }
    const result = toOpenAITool(tool)
    expect(result.type).toBe('function')
    expect(result.function.name).toBe('read')
  })
})

// =========================================================================
// MCP adapters
// =========================================================================

describe('toMCPToolDescriptor / fromMCPToolDescriptor', () => {
  const tool: ToolSchemaDescriptor = {
    name: 'git_status',
    description: 'Show git status',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object' },
  }

  it('converts to MCP descriptor (drops outputSchema)', () => {
    const mcp = toMCPToolDescriptor(tool)
    expect(mcp.name).toBe('git_status')
    expect(mcp.description).toBe('Show git status')
    expect(mcp.inputSchema).toEqual(tool.inputSchema)
    expect('outputSchema' in mcp).toBe(false)
  })

  it('round-trips through MCP format', () => {
    const mcp = toMCPToolDescriptor(tool)
    const back = fromMCPToolDescriptor(mcp)
    expect(back.name).toBe(tool.name)
    expect(back.description).toBe(tool.description)
    expect(back.inputSchema).toEqual(tool.inputSchema)
  })

  it('handles missing description in fromMCPToolDescriptor', () => {
    const back = fromMCPToolDescriptor({
      name: 'test',
      inputSchema: { type: 'object' },
    })
    expect(back.description).toBe('')
  })
})

// =========================================================================
// AGENTS.md V2 parser
// =========================================================================

describe('parseAgentsMdV2', () => {
  it('parses YAML front matter', () => {
    const content = `---
name: CodeReviewer
description: Reviews code for quality
version: 2.0.0
tags: [code, review, quality]
---

Some body content.`

    const doc = parseAgentsMdV2(content)
    expect(doc.metadata.name).toBe('CodeReviewer')
    expect(doc.metadata.description).toBe('Reviews code for quality')
    expect(doc.metadata.version).toBe('2.0.0')
    expect(doc.metadata.tags).toEqual(['code', 'review', 'quality'])
    expect(doc.rawContent).toBe(content)
  })

  it('parses capabilities section', () => {
    const content = `---
name: Agent
---

## Capabilities
- Code Review: Analyzes code for bugs and style issues
- Testing: Generates unit tests for functions
- Refactoring: Suggests code improvements`

    const doc = parseAgentsMdV2(content)
    expect(doc.capabilities).toHaveLength(3)
    expect(doc.capabilities![0]!.name).toBe('Code Review')
    expect(doc.capabilities![0]!.description).toBe('Analyzes code for bugs and style issues')
    expect(doc.capabilities![2]!.name).toBe('Refactoring')
  })

  it('parses memory section', () => {
    const content = `---
name: Agent
---

## Memory
namespaces: [conversations, lessons, conventions]
maxRecords: 1000`

    const doc = parseAgentsMdV2(content)
    expect(doc.memory).toBeDefined()
    expect(doc.memory!.namespaces).toEqual(['conversations', 'lessons', 'conventions'])
    expect(doc.memory!.maxRecords).toBe(1000)
  })

  it('parses security section with sub-headings', () => {
    const content = `---
name: Agent
---

## Security
### Allowed Tools
- read_file
- write_file
- search
### Blocked Tools
- rm_rf
- force_push`

    const doc = parseAgentsMdV2(content)
    expect(doc.security).toBeDefined()
    expect(doc.security!.allowedTools).toEqual(['read_file', 'write_file', 'search'])
    expect(doc.security!.blockedTools).toEqual(['rm_rf', 'force_push'])
  })

  it('parses security section with ! prefix convention', () => {
    const content = `---
name: Agent
---

## Security
- read_file
- write_file
- !delete_file`

    const doc = parseAgentsMdV2(content)
    expect(doc.security!.allowedTools).toEqual(['read_file', 'write_file'])
    expect(doc.security!.blockedTools).toEqual(['delete_file'])
  })

  it('handles content without front matter', () => {
    const content = `## Capabilities
- Coding: Write code`

    const doc = parseAgentsMdV2(content)
    expect(doc.metadata.name).toBe('')
    expect(doc.capabilities).toHaveLength(1)
  })

  it('handles empty content', () => {
    const doc = parseAgentsMdV2('')
    expect(doc.metadata.name).toBe('')
    expect(doc.capabilities).toBeUndefined()
    expect(doc.memory).toBeUndefined()
    expect(doc.security).toBeUndefined()
  })

  it('parses memory section with bullet-list namespaces', () => {
    const content = `---
name: Agent
---

## Memory
- conversations
- lessons`

    const doc = parseAgentsMdV2(content)
    expect(doc.memory).toBeDefined()
    expect(doc.memory!.namespaces).toEqual(['conversations', 'lessons'])
  })
})

// =========================================================================
// generateAgentsMd
// =========================================================================

describe('generateAgentsMd', () => {
  it('produces valid markdown with front matter', () => {
    const md = generateAgentsMd({
      metadata: { name: 'TestAgent', description: 'Does things', version: '1.0.0', tags: ['test'] },
      rawContent: '',
    })

    expect(md).toContain('---')
    expect(md).toContain('name: TestAgent')
    expect(md).toContain('description: Does things')
    expect(md).toContain('version: 1.0.0')
    expect(md).toContain('tags: [test]')
  })

  it('generates capabilities section', () => {
    const md = generateAgentsMd({
      metadata: { name: 'A' },
      capabilities: [{ name: 'Review', description: 'Reviews code' }],
      rawContent: '',
    })

    expect(md).toContain('## Capabilities')
    expect(md).toContain('- Review: Reviews code')
  })

  it('generates memory section', () => {
    const md = generateAgentsMd({
      metadata: { name: 'A' },
      memory: { namespaces: ['conv', 'lessons'], maxRecords: 500 },
      rawContent: '',
    })

    expect(md).toContain('## Memory')
    expect(md).toContain('namespaces: [conv, lessons]')
    expect(md).toContain('maxRecords: 500')
  })

  it('generates security section', () => {
    const md = generateAgentsMd({
      metadata: { name: 'A' },
      security: { allowedTools: ['read'], blockedTools: ['delete'] },
      rawContent: '',
    })

    expect(md).toContain('## Security')
    expect(md).toContain('### Allowed Tools')
    expect(md).toContain('- read')
    expect(md).toContain('### Blocked Tools')
    expect(md).toContain('- delete')
  })
})

// =========================================================================
// Round-trip: parse -> generate -> parse
// =========================================================================

describe('parseAgentsMdV2 -> generateAgentsMd -> parseAgentsMdV2 round-trip', () => {
  it('preserves metadata through round-trip', () => {
    const original = `---
name: RoundTripper
description: Tests round-tripping
version: 3.0.0
tags: [test, roundtrip]
---

## Capabilities
- Parse: Parses documents
- Generate: Generates output

## Memory
namespaces: [data, cache]
maxRecords: 200

## Security
### Allowed Tools
- read_file
### Blocked Tools
- rm_rf`

    const doc1 = parseAgentsMdV2(original)
    const generated = generateAgentsMd(doc1)
    const doc2 = parseAgentsMdV2(generated)

    // Metadata
    expect(doc2.metadata.name).toBe(doc1.metadata.name)
    expect(doc2.metadata.description).toBe(doc1.metadata.description)
    expect(doc2.metadata.version).toBe(doc1.metadata.version)
    expect(doc2.metadata.tags).toEqual(doc1.metadata.tags)

    // Capabilities
    expect(doc2.capabilities).toHaveLength(doc1.capabilities!.length)
    expect(doc2.capabilities![0]!.name).toBe(doc1.capabilities![0]!.name)
    expect(doc2.capabilities![0]!.description).toBe(doc1.capabilities![0]!.description)

    // Memory
    expect(doc2.memory!.namespaces).toEqual(doc1.memory!.namespaces)
    expect(doc2.memory!.maxRecords).toBe(doc1.memory!.maxRecords)

    // Security
    expect(doc2.security!.allowedTools).toEqual(doc1.security!.allowedTools)
    expect(doc2.security!.blockedTools).toEqual(doc1.security!.blockedTools)
  })
})

// =========================================================================
// toLegacyConfig backward compatibility
// =========================================================================

describe('toLegacyConfig', () => {
  it('converts v2 doc to legacy AgentsMdConfig', () => {
    const doc = parseAgentsMdV2(`---
name: Legacy
description: A legacy-compat agent
---

## Capabilities
- Lint: Lints code
- Format: Formats code

## Security
### Allowed Tools
- eslint
### Blocked Tools
- rm`)

    const legacy = toLegacyConfig(doc)

    expect(legacy.instructions).toContain('A legacy-compat agent')
    expect(legacy.instructions).toContain('Lint: Lints code')
    expect(legacy.instructions).toContain('Format: Formats code')
    expect(legacy.rules).toEqual([])
    expect(legacy.allowedTools).toEqual(['eslint'])
    expect(legacy.blockedTools).toEqual(['rm'])
  })

  it('produces valid AgentsMdConfig with no optional fields', () => {
    const doc = parseAgentsMdV2(`---
name: Minimal
---`)

    const legacy = toLegacyConfig(doc)
    expect(legacy.instructions).toEqual([])
    expect(legacy.rules).toEqual([])
    expect(legacy.allowedTools).toBeUndefined()
    expect(legacy.blockedTools).toBeUndefined()
  })
})
