import { test, expect } from 'vitest'
import type { Request } from 'express'
import { classifyMcpHttpRequest, buildCurrentMcpDiscoverResponse, decorateCurrentMcpResponse, CURRENT_MCP_PROTOCOL_VERSION as version } from '../mcp-protocol.js'
import type { MCPRequest } from '@dzupagent/core/pipeline'
import type { MCPRouterProtocolConfig } from '../types.js'

const config: MCPRouterProtocolConfig = { current: { serverInfo: { name: 'fixture', version: '1' } } }
const req = (headers: Record<string, string>) => ({ get: (name: string) => headers[name] }) as Request
const meta = { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'client', version: '1' } }
test('current MCP discovery and deterministic lists carry protocol cache metadata', () => {
  expect(() => buildCurrentMcpDiscoverResponse({ jsonrpc: '2.0', method: 'server/discover' }, {})).toThrow(/not configured/)
  expect(buildCurrentMcpDiscoverResponse({ jsonrpc: '2.0', method: 'server/discover' }, { current: { ...config.current!, instructions: 'fixture' } })).toMatchObject({ id: null, result: { instructions: 'fixture', supportedVersions: [version] } })
  const response = { jsonrpc: '2.0' as const, id: 1, result: { tools: [{ name: 'z' }, { name: 'a' }], _meta: { retained: true } } }
  const decorated = decorateCurrentMcpResponse('tools/list', response, config)
  expect(decorated.result).toMatchObject({ tools: [{ name: 'a' }, { name: 'z' }], ttlMs: 0, cacheScope: 'private', resultType: 'complete', _meta: { retained: true } })
  expect(response.result.tools[0]!.name).toBe('z')
})
test('current MCP headers cannot contradict version, method, routing name or client metadata', () => {
  const request: MCPRequest = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup', _meta: meta } }
  const headers = { 'MCP-Protocol-Version': version, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'lookup' }
  expect(classifyMcpHttpRequest(req(headers), request, config).ok).toBe(true)
  for (const changes of [{ 'Mcp-Method': 'tools/list' }, { 'Mcp-Name': 'different' }, { 'Mcp-Name': '=?base64?invalid?=' }, { 'MCP-Protocol-Version': 'older' }]) {
    expect(classifyMcpHttpRequest(req({ ...headers, ...changes }), request, config).ok).toBe(false)
  }
  expect(classifyMcpHttpRequest(req(headers), { ...request, params: {} }, config).ok).toBe(false)
  for (const changes of [{ 'io.modelcontextprotocol/clientCapabilities': null }, { 'io.modelcontextprotocol/clientInfo': { name: 'client' } }, { 'io.modelcontextprotocol/protocolVersion': undefined }]) {
    expect(classifyMcpHttpRequest(req(headers), { ...request, params: { name: 'lookup', _meta: { ...meta, ...changes } } }, config).ok).toBe(false)
  }
  const encoded = '=?base64?' + Buffer.from('lookup').toString('base64') + '?='
  expect(classifyMcpHttpRequest(req({ ...headers, 'Mcp-Name': encoded }), request, config).ok).toBe(true)
  expect(classifyMcpHttpRequest(req(headers), request, {}).ok).toBe(false)
  expect(classifyMcpHttpRequest(req({ 'MCP-Protocol-Version': 'unsupported' }), { jsonrpc: '2.0', method: 'tools/list' }, config).ok).toBe(false)
})
