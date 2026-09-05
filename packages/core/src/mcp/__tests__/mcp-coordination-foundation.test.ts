import { describe, expect, it } from 'vitest'
import { DzupAgentMCPServer } from '../mcp-server.js'
import type { MCPExposedTool, MCPServerOptions } from '../mcp-server.js'

const request = { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name: 'inspect' } }

function outputTool(structuredContent: Record<string, unknown>, properties = {}): MCPExposedTool {
  return {
    name: 'inspect', description: 'Inspect state',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties, additionalProperties: false },
    handler: async () => ({ content: [], structuredContent }),
  }
}

describe('coordination MCP foundation', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'rejects undeclared own output field %s without leaking its value', async (key) => {
      const content = JSON.parse(`{"${key}":"private-output-marker"}`) as Record<string, unknown>
      const server = new DzupAgentMCPServer({ name: 'fixture', version: '1', tools: [outputTool(content)] })
      const result = await server.handleRequest(request)
      expect(result?.error).toMatchObject({ code: -32000, message: 'MCP_OUTPUT_SCHEMA_MISMATCH' })
      expect(result).not.toHaveProperty('result')
      expect(JSON.stringify(result)).not.toContain('private-output-marker')
    },
  )

  it.each(['constructor', 'toString', '__proto__'])(
    'still validates an explicitly declared output field %s', async (key) => {
      const properties = JSON.parse(`{"${key}":{"type":"string"}}`) as Record<string, { type: string }>
      const valid = JSON.parse(`{"${key}":"allowed"}`) as Record<string, unknown>
      const invalid = JSON.parse(`{"${key}":42}`) as Record<string, unknown>
      const good = new DzupAgentMCPServer({ name: 'fixture', version: '1', tools: [outputTool(valid, properties)] })
      const bad = new DzupAgentMCPServer({ name: 'fixture', version: '1', tools: [outputTool(invalid, properties)] })
      expect(await good.handleRequest(request)).toMatchObject({ result: { structuredContent: valid } })
      expect(await bad.handleRequest(request)).toHaveProperty('error.message', 'MCP_OUTPUT_SCHEMA_MISMATCH')
    },
  )

  it.each([false, true])('preserves additionalProperties=%s in local and wire tool descriptors', async (closure) => {
    const tool = outputTool({})
    tool.inputSchema = { type: 'object', properties: {}, additionalProperties: closure }
    const server = new DzupAgentMCPServer({ name: 'fixture', version: '1', tools: [tool] })
    expect(server.listTools()[0]?.inputSchema).toEqual(tool.inputSchema)
    const result = await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(result).toHaveProperty('result.tools.0.inputSchema.additionalProperties', closure)
  })

  it('omits additionalProperties when the tool did not declare it', () => {
    const server = new DzupAgentMCPServer({ name: 'fixture', version: '1', tools: [outputTool({})] })
    expect(server.listTools()[0]?.inputSchema).not.toHaveProperty('additionalProperties')
  })

  it('preserves schema-valued additionalProperties in input descriptors', () => {
    const tool = outputTool({})
    tool.inputSchema = { type: 'object', properties: {}, additionalProperties: { type: 'string' } }
    const server = new DzupAgentMCPServer({ name: 'fixture', version: '1', tools: [tool] })
    expect(server.listTools()[0]?.inputSchema).toEqual(tool.inputSchema)
  })

  it('publishes optional common instructions in legacy initialization and current discovery', async () => {
    // Structural assignment lets this test run RED before the new option exists.
    const options = { name: 'fixture', version: '1', instructions: 'Read current state before acting.', currentProtocol: { enabled: true } }
    const server = new DzupAgentMCPServer(options satisfies MCPServerOptions)
    const initialize = await server.handleRequest({ jsonrpc: '2.0', id: 3, method: 'initialize' })
    const discover = await server.handleRequest({ jsonrpc: '2.0', id: 4, method: 'server/discover' }, { protocolVersion: '2026-07-28' })
    expect(initialize).toHaveProperty('result.instructions', options.instructions)
    expect(discover).toHaveProperty('result.instructions', options.instructions)
  })

  it('keeps an explicit current-protocol instruction override, including an empty string', async () => {
    for (const instructions of ['Current protocol guidance.', '']) {
      const options = { name: 'fixture', version: '1', instructions: 'Legacy guidance.', currentProtocol: { enabled: true, instructions } }
      const server = new DzupAgentMCPServer(options)
      expect(await server.handleRequest({ jsonrpc: '2.0', id: 5, method: 'initialize' })).toHaveProperty('result.instructions', options.instructions)
      expect(await server.handleRequest({ jsonrpc: '2.0', id: 6, method: 'server/discover' }, { protocolVersion: '2026-07-28' })).toHaveProperty('result.instructions', instructions)
    }
  })

  it('retains legacy omission when instructions were supplied only for the current protocol', async () => {
    const server = new DzupAgentMCPServer({ name: 'fixture', version: '1', currentProtocol: { instructions: 'Current only.' } })
    expect(await server.handleRequest({ jsonrpc: '2.0', id: 7, method: 'initialize' })).not.toHaveProperty('result.instructions')
    expect(await server.handleRequest({ jsonrpc: '2.0', id: 8, method: 'server/discover' }, { protocolVersion: '2026-07-28' })).toHaveProperty('result.instructions', 'Current only.')
  })
})
