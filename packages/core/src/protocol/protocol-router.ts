/**
 * ProtocolRouter — selects the correct adapter based on message URI scheme.
 *
 * Routes outgoing messages to the correct ProtocolAdapter by inspecting
 * the scheme portion of `message.to`. For example:
 * - `forge://acme/agent` -> adapter registered for 'forge'
 * - `a2a://remote/agent` -> adapter registered for 'a2a'
 * - `https://example.com/agent` -> adapter registered for 'https'
 */
import type { ProtocolAdapter, SendOptions } from './adapter.js'
import type { ForgeMessage } from './message-types.js'
import { ForgeError } from '../errors/forge-error.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ProtocolRouterConfig {
  /** Default adapter when no scheme-specific adapter matches. */
  defaultAdapter?: ProtocolAdapter
}

// ---------------------------------------------------------------------------
// URI scheme extraction
// ---------------------------------------------------------------------------

/**
 * Extract the scheme from a URI (everything before `://`).
 * Returns undefined if no scheme is found.
 */
function extractScheme(uri: string): string | undefined {
  const idx = uri.indexOf('://')
  if (idx <= 0) return undefined
  return uri.slice(0, idx).toLowerCase()
}

// ---------------------------------------------------------------------------
// ProtocolRouter
// ---------------------------------------------------------------------------

export class ProtocolRouter {
  private readonly adapters = new Map<string, ProtocolAdapter>()
  private readonly defaultAdapter: ProtocolAdapter | undefined

  constructor(config?: ProtocolRouterConfig) {
    this.defaultAdapter = config?.defaultAdapter
  }

  /**
   * Register an adapter for a protocol scheme.
   * @param scheme - URI scheme without :// (e.g., 'forge', 'a2a', 'mcp')
   */
  registerAdapter(scheme: string, adapter: ProtocolAdapter): void {
    this.adapters.set(scheme.toLowerCase(), adapter)
  }

  /**
   * Remove a registered adapter.
   */
  removeAdapter(scheme: string): void {
    this.adapters.delete(scheme.toLowerCase())
  }

  /**
   * Route a message to the correct adapter based on `message.to` URI scheme.
   * Throws ForgeError with code MESSAGE_ROUTING_FAILED if no adapter matches.
   */
  async route(message: ForgeMessage, options?: SendOptions): Promise<ForgeMessage> {
    const adapter = this.resolveAdapter(message.to)
    return adapter.send(message, options)
  }

  /**
   * Route a message for streaming.
   */
  routeStream(message: ForgeMessage, options?: SendOptions): AsyncIterable<ForgeMessage> {
    const adapter = this.resolveAdapter(message.to)
    return adapter.stream(message, options)
  }

  /**
   * Get the adapter for a given URI.
   */
  getAdapterForUri(uri: string): ProtocolAdapter | undefined {
    const scheme = extractScheme(uri)
    if (scheme) {
      const adapter = this.adapters.get(scheme)
      if (adapter) return adapter
    }
    return this.defaultAdapter
  }

  /**
   * List all registered schemes.
   */
  getRegisteredSchemes(): string[] {
    return [...this.adapters.keys()]
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private resolveAdapter(uri: string): ProtocolAdapter {
    const scheme = extractScheme(uri)
    if (scheme) {
      const adapter = this.adapters.get(scheme)
      if (adapter) return adapter
    }

    if (this.defaultAdapter) {
      return this.defaultAdapter
    }

    throw new ForgeError({
      code: 'MESSAGE_ROUTING_FAILED',
      message: `No adapter registered for scheme "${scheme ?? 'unknown'}" (URI: ${uri})`,
      recoverable: false,
      context: { uri, scheme: scheme ?? 'unknown', registeredSchemes: this.getRegisteredSchemes() },
    })
  }
}
