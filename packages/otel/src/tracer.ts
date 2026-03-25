/**
 * ForgeTracer — wraps OTel SDK tracer with ForgeAgent-specific helpers.
 *
 * Provides convenience methods for starting spans with the correct
 * semantic attributes pre-populated. If @opentelemetry/api is not installed,
 * all operations gracefully degrade to no-ops.
 *
 * @example
 * ```ts
 * const tracer = new ForgeTracer({ serviceName: 'my-agent-service' })
 *
 * await tracer.startAgentSpan('code-gen', 'run-123', async (span) => {
 *   await tracer.startLLMSpan('claude-sonnet-4-6', 'anthropic', async (llmSpan) => {
 *     const result = await model.invoke(messages)
 *     llmSpan.setAttribute(ForgeSpanAttr.GEN_AI_USAGE_INPUT_TOKENS, result.inputTokens)
 *   })
 * })
 * ```
 */

import type { OTelSpan, OTelTracer, OTelContext } from './otel-types.js'
import { SpanKind, SpanStatusCode } from './otel-types.js'
import { NoopTracer } from './noop.js'
import { ForgeSpanAttr } from './span-attributes.js'
import { forgeContextStore, type ForgeTraceContext } from './trace-context-store.js'

/**
 * Configuration for ForgeTracer.
 */
export interface ForgeTracerConfig {
  /** Service name reported to OTel backends (default: 'forgeagent') */
  serviceName?: string

  /**
   * An OTel Tracer instance from @opentelemetry/api.
   * If not provided, a NoopTracer is used (no telemetry emitted).
   */
  tracer?: OTelTracer
}

/**
 * Snapshot of the current trace context.
 */
export interface ForgeTraceSnapshot {
  traceId: string
  spanId: string
  agentId: string | undefined
  runId: string | undefined
}

/**
 * ForgeTracer wraps an OTel tracer with domain-specific span helpers.
 *
 * Each helper method:
 * 1. Creates a span with pre-populated ForgeAgent semantic attributes
 * 2. Runs the callback within a ForgeTraceContext (AsyncLocalStorage)
 * 3. Ends the span and sets error status if the callback throws
 */
export class ForgeTracer {
  private readonly _tracer: OTelTracer
  private readonly _serviceName: string

  constructor(config?: ForgeTracerConfig) {
    this._serviceName = config?.serviceName ?? 'forgeagent'
    this._tracer = config?.tracer ?? new NoopTracer()
  }

  /** The underlying OTel tracer (or NoopTracer) */
  get tracer(): OTelTracer {
    return this._tracer
  }

  /** The configured service name */
  get serviceName(): string {
    return this._serviceName
  }

  /**
   * Start an agent-level span. Sets forge.agent.id and forge.run.id.
   */
  startAgentSpan(agentId: string, runId: string, options?: { parentContext?: OTelContext }): OTelSpan {
    const span = this._tracer.startSpan(
      `agent:${agentId}`,
      {
        attributes: {
          [ForgeSpanAttr.AGENT_ID]: agentId,
          [ForgeSpanAttr.RUN_ID]: runId,
        },
        kind: SpanKind.INTERNAL,
      },
      options?.parentContext,
    )
    return span
  }

  /**
   * Start an LLM invocation span. Sets gen_ai.* attributes.
   */
  startLLMSpan(model: string, provider: string, options?: { temperature?: number; maxTokens?: number }): OTelSpan {
    const attrs: Record<string, string | number | boolean> = {
      [ForgeSpanAttr.GEN_AI_REQUEST_MODEL]: model,
      [ForgeSpanAttr.GEN_AI_SYSTEM]: provider,
    }
    if (options?.temperature !== undefined) {
      attrs[ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE] = options.temperature
    }
    if (options?.maxTokens !== undefined) {
      attrs[ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS] = options.maxTokens
    }

    return this._tracer.startSpan('llm:invoke', {
      attributes: attrs,
      kind: SpanKind.CLIENT,
    })
  }

  /**
   * Start a tool execution span. Sets forge.tool.* attributes.
   */
  startToolSpan(toolName: string, options?: { inputSize?: number }): OTelSpan {
    const attrs: Record<string, string | number | boolean> = {
      [ForgeSpanAttr.TOOL_NAME]: toolName,
    }
    if (options?.inputSize !== undefined) {
      attrs[ForgeSpanAttr.TOOL_INPUT_SIZE] = options.inputSize
    }

    return this._tracer.startSpan(`tool:${toolName}`, {
      attributes: attrs,
      kind: SpanKind.INTERNAL,
    })
  }

  /**
   * Start a memory operation span. Sets forge.memory.* attributes.
   */
  startMemorySpan(
    operation: 'read' | 'write' | 'search' | 'delete',
    namespace: string,
  ): OTelSpan {
    return this._tracer.startSpan(`memory:${operation}`, {
      attributes: {
        [ForgeSpanAttr.MEMORY_NAMESPACE]: namespace,
        [ForgeSpanAttr.MEMORY_OPERATION]: operation,
      },
      kind: SpanKind.INTERNAL,
    })
  }

  /**
   * Start a pipeline phase span. Sets forge.pipeline.phase attribute.
   */
  startPhaseSpan(phase: string, options?: { agentId?: string; runId?: string }): OTelSpan {
    const attrs: Record<string, string | number | boolean> = {
      [ForgeSpanAttr.PHASE]: phase,
    }
    if (options?.agentId) attrs[ForgeSpanAttr.AGENT_ID] = options.agentId
    if (options?.runId) attrs[ForgeSpanAttr.RUN_ID] = options.runId

    return this._tracer.startSpan(`phase:${phase}`, {
      attributes: attrs,
      kind: SpanKind.INTERNAL,
    })
  }

  /**
   * Get the current trace context snapshot.
   * Returns undefined if no active span in the ForgeTraceContext store.
   */
  currentContext(): ForgeTraceSnapshot | undefined {
    const ctx = forgeContextStore.getStore()
    if (!ctx) return undefined
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      agentId: ctx.agentId,
      runId: ctx.runId,
    }
  }

  /**
   * Inject trace context into a carrier object (W3C Trace Context format).
   * Reads from the current ForgeTraceContext store.
   */
  inject(carrier: Record<string, string>): void {
    const ctx = forgeContextStore.getStore()
    if (!ctx) return
    // W3C traceparent: version-traceId-spanId-flags
    carrier['traceparent'] = `00-${ctx.traceId}-${ctx.spanId}-01`
    // Propagate baggage
    const baggageEntries = Object.entries(ctx.baggage)
    if (baggageEntries.length > 0) {
      carrier['baggage'] = baggageEntries
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join(',')
    }
  }

  /**
   * Extract trace context from a carrier object (W3C Trace Context format).
   * Returns a partial ForgeTraceContext or undefined if no traceparent header found.
   */
  extract(carrier: Record<string, string>): ForgeTraceContext | undefined {
    const traceparent = carrier['traceparent']
    if (!traceparent) return undefined

    const parts = traceparent.split('-')
    if (parts.length < 4) return undefined

    const traceId = parts[1]
    const spanId = parts[2]
    if (!traceId || !spanId) return undefined

    // Parse baggage
    const baggage: Record<string, string> = {}
    const baggageHeader = carrier['baggage']
    if (baggageHeader) {
      for (const entry of baggageHeader.split(',')) {
        const eqIdx = entry.indexOf('=')
        if (eqIdx > 0) {
          const key = decodeURIComponent(entry.slice(0, eqIdx).trim())
          const value = decodeURIComponent(entry.slice(eqIdx + 1).trim())
          baggage[key] = value
        }
      }
    }

    return { traceId, spanId, baggage }
  }

  /**
   * End a span with an error status. Utility for catch blocks.
   */
  endSpanWithError(span: OTelSpan, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    span.setStatus({ code: SpanStatusCode.ERROR, message })
    span.setAttribute(ForgeSpanAttr.ERROR_CODE, message)
    span.end()
  }

  /**
   * End a span with OK status.
   */
  endSpanOk(span: OTelSpan): void {
    span.setStatus({ code: SpanStatusCode.OK })
    span.end()
  }
}
