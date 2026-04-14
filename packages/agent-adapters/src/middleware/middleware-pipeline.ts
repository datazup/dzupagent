import type { AgentEvent, AgentInput, AdapterProviderId } from '../types.js'

/**
 * A middleware transforms an agent event stream.
 * Can filter, transform, inject events, or abort execution.
 */
export type AdapterMiddleware = (
  source: AsyncGenerator<AgentEvent, void, undefined>,
  context: MiddlewareContext,
) => AsyncGenerator<AgentEvent, void, undefined>

export interface MiddlewareContext {
  input: AgentInput
  providerId: AdapterProviderId
  sessionId?: string
  signal?: AbortSignal
}

interface NamedMiddleware {
  name: string
  middleware: AdapterMiddleware
}

/**
 * Composable middleware pipeline for agent event streams.
 * Middleware is applied in order: first added = outermost wrapper.
 */
export class MiddlewarePipeline {
  private readonly middlewares: NamedMiddleware[] = []

  /** Add middleware to the pipeline */
  use(name: string, middleware: AdapterMiddleware): this {
    this.middlewares.push({ name, middleware })
    return this
  }

  /** Remove middleware by name */
  remove(name: string): this {
    const idx = this.middlewares.findIndex(m => m.name === name)
    if (idx !== -1) this.middlewares.splice(idx, 1)
    return this
  }

  /** Check if middleware exists by name */
  has(name: string): boolean {
    return this.middlewares.some(m => m.name === name)
  }

  /** List registered middleware names (in order) */
  list(): string[] {
    return this.middlewares.map(m => m.name)
  }

  /** Wrap an event source with all middleware in the pipeline */
  wrap(
    source: AsyncGenerator<AgentEvent, void, undefined>,
    context: MiddlewareContext,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    let current = source
    // Apply in reverse so first-added is outermost
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      current = this.middlewares[i]!.middleware(current, context)
    }
    return current
  }
}
