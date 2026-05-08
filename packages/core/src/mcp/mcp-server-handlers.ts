/**
 * MCP Server method handlers — pure functions implementing tool/resource/prompt/sampling
 * call semantics. Each handler accepts the relevant registry maps + a sampling handler
 * and returns a fully-formed `MCPResponse`.
 *
 * Keeping these as standalone functions (instead of class methods) makes them easy to
 * unit-test in isolation and keeps the server class focused on routing.
 */
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
import type { MCPToolResult } from './mcp-types.js'

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

  try {
    const result = await tool.handler(args)
    if (typeof result === 'string') {
      return buildResult(id, {
        content: [{ type: 'text', text: result }],
        isError: false,
      } satisfies MCPToolResult)
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
