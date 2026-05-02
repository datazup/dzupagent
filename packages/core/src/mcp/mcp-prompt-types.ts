/**
 * MCP Prompt type definitions.
 *
 * Prompts are reusable templates exposed by MCP servers. Clients can list
 * prompt descriptors and request concrete prompt messages with arguments.
 */

/** An argument accepted by an MCP prompt */
export interface MCPPromptArgument {
  name: string
  description?: string
  required?: boolean
}

/** Prompt descriptor returned by prompts/list */
export interface MCPPromptDescriptor {
  name: string
  description?: string
  arguments?: MCPPromptArgument[]
}

/** Text content returned in a prompt message */
export interface MCPPromptTextContent {
  type: 'text'
  text: string
}

/** Image content returned in a prompt message */
export interface MCPPromptImageContent {
  type: 'image'
  data: string
  mimeType: string
}

/** Embedded resource content returned in a prompt message */
export interface MCPPromptResourceContent {
  type: 'resource'
  resource: {
    uri: string
    mimeType?: string
    text?: string
    /** Base64-encoded binary content */
    blob?: string
  }
}

/** Content within a prompt message */
export type MCPPromptContent =
  | MCPPromptTextContent
  | MCPPromptImageContent
  | MCPPromptResourceContent

/** A message returned by prompts/get */
export interface MCPPromptMessage {
  role: 'user' | 'assistant'
  content: MCPPromptContent
}

/** Result returned by prompts/get */
export interface MCPPromptGetResult {
  description?: string
  messages: MCPPromptMessage[]
}

/** Function that resolves an MCP prompt with client-provided arguments */
export type MCPPromptHandler = (args: Record<string, unknown>) => Promise<MCPPromptGetResult>
