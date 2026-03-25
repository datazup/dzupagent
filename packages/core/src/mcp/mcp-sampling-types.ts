/**
 * MCP Sampling type definitions.
 *
 * Sampling allows MCP servers to request LLM completions through
 * the client, enabling agentic behaviors while keeping the human in the loop.
 */

/** Content within a sampling message */
export type MCPSamplingContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** A message in a sampling request */
export interface MCPSamplingMessage {
  role: 'user' | 'assistant'
  content: MCPSamplingContent
}

/** Model selection preferences for sampling */
export interface MCPModelPreferences {
  hints?: Array<{ name?: string }>
  costPriority?: number
  speedPriority?: number
  intelligencePriority?: number
}

/** A sampling request from an MCP server */
export interface MCPSamplingRequest {
  messages: MCPSamplingMessage[]
  modelPreferences?: MCPModelPreferences
  systemPrompt?: string
  includeContext?: 'none' | 'thisServer' | 'allServers'
  temperature?: number
  maxTokens: number
  stopSequences?: string[]
  metadata?: Record<string, unknown>
}

/** Response to a sampling request */
export interface MCPSamplingResponse {
  role: 'assistant'
  content: { type: 'text'; text: string }
  model: string
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens'
}

/** Function that handles sampling requests */
export type SamplingHandler = (request: MCPSamplingRequest) => Promise<MCPSamplingResponse>
