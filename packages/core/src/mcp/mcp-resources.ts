/**
 * MCP Resource Client — discovers and reads resources from MCP servers.
 *
 * Implements the `resources/list`, `resources/templates/list`, `resources/read`,
 * and `resources/subscribe` JSON-RPC methods from the MCP specification.
 *
 * Non-fatal: errors are returned, never thrown, matching MCPClient patterns.
 */
import type {
  MCPResource,
  MCPResourceTemplate,
  MCPResourceContent,
  ResourceSubscription,
  ResourceChangeHandler,
} from './mcp-resource-types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MCPResourceClientConfig {
  /** Function to send JSON-RPC requests to the MCP server */
  sendRequest: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  /** Function to register notification handlers */
  onNotification?: (method: string, handler: (params: unknown) => void) => void
}

// ---------------------------------------------------------------------------
// Internal subscription tracking
// ---------------------------------------------------------------------------

interface TrackedSubscription {
  uri: string
  handler: ResourceChangeHandler
  active: boolean
}

// ---------------------------------------------------------------------------
// MCPResourceClient
// ---------------------------------------------------------------------------

/**
 * Client for reading and subscribing to MCP server resources.
 *
 * Usage:
 * ```ts
 * const client = new MCPResourceClient({
 *   sendRequest: (method, params) => transport.send(method, params),
 *   onNotification: (method, handler) => transport.on(method, handler),
 * })
 *
 * const resources = await client.listResources()
 * const content = await client.readResource(resources[0].uri)
 * ```
 */
export class MCPResourceClient {
  private readonly sendRequest: MCPResourceClientConfig['sendRequest']
  private readonly onNotification: MCPResourceClientConfig['onNotification']
  private readonly subscriptions: Map<string, TrackedSubscription> = new Map()
  private notificationRegistered = false

  constructor(config: MCPResourceClientConfig) {
    this.sendRequest = config.sendRequest
    this.onNotification = config.onNotification
  }

  /**
   * List all available resources from the MCP server.
   */
  async listResources(): Promise<MCPResource[]> {
    const response = await this.sendRequest('resources/list') as {
      resources?: MCPResource[]
    } | null

    if (!response || !Array.isArray(response.resources)) {
      return []
    }

    return response.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      ...(r.description !== undefined && { description: r.description }),
      ...(r.mimeType !== undefined && { mimeType: r.mimeType }),
    }))
  }

  /**
   * List resource templates (URI patterns with placeholders).
   */
  async listResourceTemplates(): Promise<MCPResourceTemplate[]> {
    const response = await this.sendRequest('resources/templates/list') as {
      resourceTemplates?: MCPResourceTemplate[]
    } | null

    if (!response || !Array.isArray(response.resourceTemplates)) {
      return []
    }

    return response.resourceTemplates.map((t) => ({
      uriTemplate: t.uriTemplate,
      name: t.name,
      ...(t.description !== undefined && { description: t.description }),
      ...(t.mimeType !== undefined && { mimeType: t.mimeType }),
    }))
  }

  /**
   * Read a specific resource by URI.
   */
  async readResource(uri: string): Promise<MCPResourceContent> {
    const response = await this.sendRequest('resources/read', { uri }) as {
      contents?: MCPResourceContent[]
    } | null

    if (!response || !Array.isArray(response.contents) || response.contents.length === 0) {
      return { uri }
    }

    const content = response.contents[0]
    if (!content) {
      return { uri }
    }

    return {
      uri: content.uri ?? uri,
      ...(content.mimeType !== undefined && { mimeType: content.mimeType }),
      ...(content.text !== undefined && { text: content.text }),
      ...(content.blob !== undefined && { blob: content.blob }),
    }
  }

  /**
   * Subscribe to resource changes. When the resource updates on the server,
   * the handler is called with the new content.
   *
   * Requires `onNotification` to be provided in the config.
   */
  subscribeToResource(uri: string, handler: ResourceChangeHandler): ResourceSubscription {
    // Ensure notification listener is set up
    this.ensureNotificationHandler()

    // Send subscribe request (fire-and-forget, best-effort)
    void this.sendRequest('resources/subscribe', { uri }).catch(() => {
      // Non-fatal — subscription may not be supported
    })

    const sub: TrackedSubscription = { uri, handler, active: true }
    const key = this.subscriptionKey(uri)
    this.subscriptions.set(key, sub)

    return {
      uri,
      unsubscribe: () => {
        sub.active = false
        this.subscriptions.delete(key)

        // Best-effort unsubscribe
        void this.sendRequest('resources/unsubscribe', { uri }).catch(() => {
          // Non-fatal
        })
      },
    }
  }

  /**
   * Dispose all active subscriptions.
   */
  dispose(): void {
    for (const [key, sub] of this.subscriptions) {
      sub.active = false
      void this.sendRequest('resources/unsubscribe', { uri: sub.uri }).catch(() => {
        // Non-fatal
      })
      this.subscriptions.delete(key)
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private subscriptionKey(uri: string): string {
    return `sub:${uri}`
  }

  private ensureNotificationHandler(): void {
    if (this.notificationRegistered || !this.onNotification) return

    this.onNotification('notifications/resources/updated', (params: unknown) => {
      const typed = params as { uri?: string } | null
      if (!typed?.uri) return

      const key = this.subscriptionKey(typed.uri)
      const sub = this.subscriptions.get(key)
      if (!sub || !sub.active) return

      // Read the updated resource and call the handler
      void this.readResource(typed.uri).then((content) => {
        if (sub.active) {
          sub.handler(typed.uri as string, content)
        }
      }).catch(() => {
        // Non-fatal — failed to read updated resource
      })
    })

    this.notificationRegistered = true
  }
}
