/**
 * MCP Sampling — routes MCP sampling requests through a provided LLM function.
 *
 * Sampling allows MCP servers to request LLM completions through the client,
 * enabling agentic behaviors while keeping the human in the loop via
 * configurable budget constraints and token limits.
 */
import type {
  MCPSamplingRequest,
  MCPSamplingResponse,
  MCPSamplingContent,
  SamplingHandler,
} from './mcp-sampling-types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MCPSamplingConfig {
  /** Default model to use for sampling when no preferences are specified */
  defaultModel?: string
  /** Maximum allowed tokens per sampling request (default: 4096) */
  maxAllowedTokens?: number
  /** Budget constraints */
  budget?: {
    /** Maximum cost in cents for a single sampling request */
    maxCostCents?: number
    /** Maximum total tokens (prompt + completion) allowed */
    maxTokens?: number
  }
}

// ---------------------------------------------------------------------------
// LLM invoke interface
// ---------------------------------------------------------------------------

/** Message format expected by the LLM invoke function */
export interface LLMInvokeMessage {
  role: string
  content: string
}

/** Options passed to the LLM invoke function */
export interface LLMInvokeOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  stopSequences?: string[]
}

/** Result returned by the LLM invoke function */
export interface LLMInvokeResult {
  content: string
  model: string
  stopReason?: string
}

/** LLM invoke function signature */
export type LLMInvokeFn = (
  messages: LLMInvokeMessage[],
  options?: LLMInvokeOptions,
) => Promise<LLMInvokeResult>

// ---------------------------------------------------------------------------
// Sampling handler factory
// ---------------------------------------------------------------------------

/**
 * Create a sampling handler that routes MCP sampling requests through a
 * provided LLM function.
 *
 * The handler validates token limits, selects a model based on preferences,
 * and enforces budget constraints before invoking the LLM.
 *
 * @param llmInvoke - Function to call the LLM
 * @param config - Optional configuration for limits and defaults
 * @returns A SamplingHandler that can be registered with an MCP server
 */
export function createSamplingHandler(
  llmInvoke: LLMInvokeFn,
  config?: MCPSamplingConfig,
): SamplingHandler {
  const maxAllowed = config?.maxAllowedTokens ?? 4096
  const defaultModel = config?.defaultModel

  return async (request: MCPSamplingRequest): Promise<MCPSamplingResponse> => {
    // 1. Validate maxTokens
    const clampedMaxTokens = Math.min(request.maxTokens, maxAllowed)

    // 2. Check budget constraints
    if (config?.budget?.maxTokens !== undefined) {
      if (clampedMaxTokens > config.budget.maxTokens) {
        throw new Error(
          `Sampling request exceeds token budget: requested ${clampedMaxTokens}, max ${config.budget.maxTokens}`,
        )
      }
    }

    // 3. Select model from preferences or default
    const model = selectModel(request.modelPreferences?.hints, defaultModel)

    // 4. Convert MCP messages to LLM format
    const messages: LLMInvokeMessage[] = []

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }

    for (const msg of request.messages) {
      messages.push({
        role: msg.role,
        content: contentToText(msg.content),
      })
    }

    // 5. Invoke the LLM
    const result = await llmInvoke(messages, {
      model,
      temperature: request.temperature,
      maxTokens: clampedMaxTokens,
      stopSequences: request.stopSequences,
    })

    // 6. Map the result to MCPSamplingResponse
    return {
      role: 'assistant',
      content: { type: 'text', text: result.content },
      model: result.model,
      stopReason: mapStopReason(result.stopReason),
    }
  }
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/** Result of registering a sampling handler */
export interface SamplingRegistration {
  unregister(): void
}

/**
 * Register the sampling handler with an MCP server notification system.
 *
 * When the server sends a `sampling/createMessage` request, the handler
 * is invoked and the result is returned.
 *
 * @param onRequest - Function to register request handlers on the MCP transport
 * @param handler - The sampling handler created by createSamplingHandler
 * @returns An object with an unregister function
 */
export function registerSamplingHandler(
  onRequest: (method: string, handler: (params: unknown) => Promise<unknown>) => void,
  handler: SamplingHandler,
): SamplingRegistration {
  let registered = true

  const wrappedHandler = async (params: unknown): Promise<unknown> => {
    if (!registered) {
      throw new Error('Sampling handler has been unregistered')
    }

    const request = params as MCPSamplingRequest
    return handler(request)
  }

  onRequest('sampling/createMessage', wrappedHandler)

  return {
    unregister() {
      registered = false
    },
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Select a model based on preference hints or fall back to the default.
 */
function selectModel(
  hints?: Array<{ name?: string }>,
  defaultModel?: string,
): string | undefined {
  if (hints && hints.length > 0) {
    // Use the first hint that has a name
    for (const hint of hints) {
      if (hint.name) {
        return hint.name
      }
    }
  }
  return defaultModel
}

/**
 * Convert MCP content to plain text.
 */
function contentToText(content: MCPSamplingContent): string {
  if (content.type === 'text') {
    return content.text
  }
  // For images, return a placeholder — the actual LLM function may handle
  // multimodal content differently
  return `[Image: ${content.mimeType}]`
}

/**
 * Map an LLM stop reason string to the MCP stop reason enum.
 */
function mapStopReason(
  reason?: string,
): MCPSamplingResponse['stopReason'] {
  if (!reason) return undefined

  const normalized = reason.toLowerCase().replace(/[_-]/g, '')
  if (normalized === 'endturn' || normalized === 'stop' || normalized === 'end') {
    return 'endTurn'
  }
  if (normalized === 'stopsequence') {
    return 'stopSequence'
  }
  if (normalized === 'maxtokens' || normalized === 'length') {
    return 'maxTokens'
  }
  return undefined
}
