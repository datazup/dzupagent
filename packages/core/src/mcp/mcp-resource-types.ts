/**
 * MCP Resource type definitions.
 *
 * Resources represent data that MCP servers expose for reading by clients.
 * Supports listing, reading, templated URIs, and change subscriptions.
 */

/** A resource exposed by an MCP server */
export interface MCPResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

/** A templated resource URI pattern */
export interface MCPResourceTemplate {
  uriTemplate: string
  name: string
  description?: string
  mimeType?: string
}

/** Content returned when reading a resource */
export interface MCPResourceContent {
  uri: string
  mimeType?: string
  text?: string
  /** Base64-encoded binary content */
  blob?: string
}

/** An active subscription to resource changes */
export interface ResourceSubscription {
  uri: string
  unsubscribe(): void
}

/** Handler called when a subscribed resource changes */
export type ResourceChangeHandler = (uri: string, content: MCPResourceContent) => void
