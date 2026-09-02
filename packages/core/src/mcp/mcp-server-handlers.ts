/**
 * MCP Server method handlers — pure functions implementing tool/resource/prompt/sampling
 * call semantics. Each handler accepts the relevant registry maps + a sampling handler
 * and returns a fully-formed `MCPResponse`.
 *
 * Keeping these as standalone functions (instead of class methods) makes them easy to
 * unit-test in isolation and keeps the server class focused on routing.
 */
import { isDeepStrictEqual } from 'node:util'
import type { MCPPromptGetResult } from './mcp-prompt-types.js'
import type {
  MCPSamplingRequest,
  SamplingHandler,
} from './mcp-sampling-types.js'
import type {
  MCPExposedPrompt,
  MCPExposedResource,
  MCPExposedResourceTemplate,
  MCPExposedTool,
  MCPRequestId,
  MCPResponse,
} from './mcp-server-types.js'
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
} from './mcp-server-types.js'
import {
  buildError,
  buildResult,
  isRecordParams,
  matchesResourceTemplate,
  normalizeResourceContent,
} from './mcp-server-utils.js'
import type {
  MCPToolOutputSchema,
  MCPToolParameter,
  MCPToolResult,
} from './mcp-types.js'

const OUTPUT_SCHEMA_MISMATCH = 'MCP_OUTPUT_SCHEMA_MISMATCH'
const OUTPUT_SCHEMA_UNSUPPORTED = 'MCP_OUTPUT_SCHEMA_UNSUPPORTED'
const OUTPUT_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
])
const PARAMETER_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'required',
  'properties',
  'items',
  'enum',
  'default',
])
const PARAMETER_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
])

export function assertSupportedMCPToolOutputSchema(
  schema: MCPToolOutputSchema,
): void {
  if (!isRecordSchema(schema) || hasUnsupportedKeys(schema, OUTPUT_SCHEMA_KEYS)) {
    throw new Error(OUTPUT_SCHEMA_UNSUPPORTED)
  }
  if (
    schema.type !== 'object'
    || !isRecordSchema(schema.properties)
    || (schema.required !== undefined
      && (!Array.isArray(schema.required)
        || !schema.required.every((key) => typeof key === 'string')))
    || (schema.additionalProperties !== undefined
      && typeof schema.additionalProperties !== 'boolean')
  ) {
    throw new Error(OUTPUT_SCHEMA_UNSUPPORTED)
  }
  for (const parameter of Object.values(schema.properties)) {
    assertSupportedParameterSchema(parameter)
  }
}

function assertSupportedParameterSchema(schema: MCPToolParameter): void {
  if (
    !isRecordSchema(schema)
    || hasUnsupportedKeys(schema, PARAMETER_SCHEMA_KEYS)
    || typeof schema.type !== 'string'
    || !PARAMETER_TYPES.has(schema.type)
    || (schema.description !== undefined && typeof schema.description !== 'string')
    || (schema.required !== undefined && typeof schema.required !== 'boolean')
    || (schema.enum !== undefined && !Array.isArray(schema.enum))
  ) {
    throw new Error(OUTPUT_SCHEMA_UNSUPPORTED)
  }

  if (schema.properties !== undefined) {
    if (schema.type !== 'object' || !isRecordSchema(schema.properties)) {
      throw new Error(OUTPUT_SCHEMA_UNSUPPORTED)
    }
    for (const nested of Object.values(schema.properties)) {
      assertSupportedParameterSchema(nested)
    }
  }

  if (schema.items !== undefined) {
    if (schema.type !== 'array') {
      throw new Error(OUTPUT_SCHEMA_UNSUPPORTED)
    }
    assertSupportedParameterSchema(schema.items)
  }
}

function hasUnsupportedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).some((key) => !allowed.has(key))
}

function isRecordSchema(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function matchesOutputSchema(
  schema: MCPToolOutputSchema,
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecordSchema(value)) return false

  for (const required of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, required)) return false
  }
  if (
    schema.additionalProperties === false
    && Object.keys(value).some((key) => !(key in schema.properties))
  ) {
    return false
  }
  return Object.entries(schema.properties).every(
    ([key, parameter]) => !Object.prototype.hasOwnProperty.call(value, key)
      || matchesParameterSchema(parameter, value[key]),
  )
}

function matchesParameterSchema(
  schema: MCPToolParameter,
  value: unknown,
): boolean {
  if (
    schema.enum !== undefined
    && !schema.enum.some((candidate) => isDeepStrictEqual(candidate, value))
  ) {
    return false
  }

  switch (schema.type) {
    case 'array':
      return Array.isArray(value)
        && (schema.items === undefined
          || value.every((item) => matchesParameterSchema(schema.items!, item)))
    case 'boolean':
      return typeof value === 'boolean'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'null':
      return value === null
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'object': {
      if (!isRecordSchema(value)) return false
      const properties = schema.properties ?? {}
      for (const [key, parameter] of Object.entries(properties)) {
        if (
          parameter.required === true
          && !Object.prototype.hasOwnProperty.call(value, key)
        ) {
          return false
        }
        if (
          Object.prototype.hasOwnProperty.call(value, key)
          && !matchesParameterSchema(parameter, value[key])
        ) {
          return false
        }
      }
      return true
    }
    case 'string':
      return typeof value === 'string'
    default:
      return false
  }
}

function buildToolOutputError(
  id: MCPRequestId,
  toolName: string,
  reasonCode: typeof OUTPUT_SCHEMA_MISMATCH | typeof OUTPUT_SCHEMA_UNSUPPORTED,
): MCPResponse {
  return buildError(id, JSON_RPC_INTERNAL_ERROR, reasonCode, {
    toolName,
    reasonCode,
  })
}

export async function handleToolCall(
  tools: ReadonlyMap<string, MCPExposedTool>,
  id: MCPRequestId,
  params: Record<string, unknown> | undefined,
): Promise<MCPResponse> {
  if (!params || typeof params['name'] !== 'string') {
    return buildError(id, JSON_RPC_INVALID_PARAMS, 'Missing required param: name')
  }

  const toolName = params['name']
  const tool = tools.get(toolName)

  if (!tool) {
    return buildError(
      id,
      JSON_RPC_METHOD_NOT_FOUND,
      `Tool not found: ${toolName}`,
      { availableTools: [...tools.keys()] },
    )
  }

  const args = (params['arguments'] ?? {}) as Record<string, unknown>

  if (tool.outputSchema !== undefined) {
    try {
      assertSupportedMCPToolOutputSchema(tool.outputSchema)
    } catch {
      return buildToolOutputError(id, toolName, OUTPUT_SCHEMA_UNSUPPORTED)
    }
  }

  try {
    const result = await tool.handler(args)
    if (typeof result === 'string') {
      if (tool.outputSchema !== undefined) {
        return buildToolOutputError(id, toolName, OUTPUT_SCHEMA_MISMATCH)
      }
      return buildResult(id, {
        content: [{ type: 'text', text: result }],
        isError: false,
      } satisfies MCPToolResult)
    }
    if (
      tool.outputSchema !== undefined
      && !matchesOutputSchema(tool.outputSchema, result.structuredContent)
    ) {
      return buildToolOutputError(id, toolName, OUTPUT_SCHEMA_MISMATCH)
    }
    return buildResult(id, {
      ...result,
      isError: result.isError ?? false,
    } satisfies MCPToolResult)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return buildError(id, JSON_RPC_INTERNAL_ERROR, `Tool execution failed: ${message}`, {
      toolName,
    })
  }
}

export async function handleResourceRead(
  resources: ReadonlyMap<string, MCPExposedResource>,
  resourceTemplates: ReadonlyMap<string, MCPExposedResourceTemplate>,
  id: MCPRequestId,
  params: Record<string, unknown> | undefined,
): Promise<MCPResponse> {
  if (!params || typeof params['uri'] !== 'string') {
    return buildError(id, JSON_RPC_INVALID_PARAMS, 'Missing required param: uri')
  }

  const uri = params['uri']
  const resource = resources.get(uri)
  if (resource) {
    const content = await resource.read?.()
    return buildResult(id, {
      contents: [normalizeResourceContent(content, {
        uri,
        ...(resource.mimeType !== undefined && { mimeType: resource.mimeType }),
      })],
    })
  }

  const template = findResourceTemplate(resourceTemplates, uri)
  if (template) {
    const content = await template.read(uri)
    return buildResult(id, {
      contents: [normalizeResourceContent(content, {
        uri,
        ...(template.mimeType !== undefined && { mimeType: template.mimeType }),
      })],
    })
  }

  return buildError(id, JSON_RPC_METHOD_NOT_FOUND, `Resource not found: ${uri}`)
}

export async function handlePromptGet(
  prompts: ReadonlyMap<string, MCPExposedPrompt>,
  id: MCPRequestId,
  params: Record<string, unknown> | undefined,
): Promise<MCPResponse> {
  if (!isRecordParams(params) || typeof params['name'] !== 'string') {
    return buildError(id, JSON_RPC_INVALID_PARAMS, 'Missing required param: name')
  }

  const promptName = params['name']
  const prompt = prompts.get(promptName)

  if (!prompt) {
    return buildError(
      id,
      JSON_RPC_METHOD_NOT_FOUND,
      `Prompt not found: ${promptName}`,
      { availablePrompts: [...prompts.keys()] },
    )
  }

  const args = params['arguments'] ?? {}
  if (!isRecordParams(args)) {
    return buildError(id, JSON_RPC_INVALID_PARAMS, 'Invalid param: arguments')
  }

  try {
    const result = await prompt.get(args)
    return buildResult(id, result satisfies MCPPromptGetResult)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return buildError(id, JSON_RPC_INTERNAL_ERROR, `Prompt retrieval failed: ${message}`, {
      promptName,
    })
  }
}

export async function handleSamplingRequest(
  samplingHandler: SamplingHandler | undefined,
  id: MCPRequestId,
  params: Record<string, unknown> | undefined,
): Promise<MCPResponse> {
  if (!samplingHandler) {
    return buildError(id, JSON_RPC_METHOD_NOT_FOUND, 'Sampling is not enabled for this server')
  }

  try {
    const response = await samplingHandler((params ?? {}) as unknown as MCPSamplingRequest)
    return buildResult(id, response)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return buildError(id, JSON_RPC_INTERNAL_ERROR, `Sampling failed: ${message}`)
  }
}

export function findResourceTemplate(
  resourceTemplates: ReadonlyMap<string, MCPExposedResourceTemplate>,
  uri: string,
): MCPExposedResourceTemplate | undefined {
  for (const template of resourceTemplates.values()) {
    if (matchesResourceTemplate(template.uriTemplate, uri)) {
      return template
    }
  }
  return undefined
}
