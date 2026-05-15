/**
 * SSE vNext projection API — hierarchical streaming views.
 *
 * Inspired by Deep Agents v0.6 typed streaming projections. Adds an optional
 * projection layer on top of the flat SSE event stream so frontends can
 * subscribe to namespace-scoped views without wiring their own event routing:
 *
 *   - coordinator  — root agent messages (text, tool_call, tool_result)
 *   - subagent     — per-subagent lifecycle + messages + tools
 *   - tools        — all tool invocations across the run
 *   - raw          — the original flat event stream (default / compat mode)
 *
 * Usage:
 *   const proj = new SSEProjectionRouter(writer)
 *   proj.setNamespace('subagent')
 *   proj.push(event, { agentId: 'sub-1', agentRole: 'coder' })
 *
 * The projection router is additive — it never breaks existing SSEWriter
 * consumers. Pass `namespace: 'raw'` (or omit it) to get current behaviour.
 */

import type { SSEWriter } from './sse-handler.js'

// ---------------------------------------------------------------------------
// Namespace types
// ---------------------------------------------------------------------------

/** Supported projection namespaces. */
export type SSENamespace = 'coordinator' | 'subagent' | 'tools' | 'raw'

/** Metadata attached to events for projection routing. */
export interface ProjectionContext {
  /** Agent ID for subagent-scoped events. */
  agentId?: string
  /** Human-readable role (coordinator, coder, reviewer, etc.). */
  agentRole?: string
  /** Pipeline run ID if the event originates from a pipeline step. */
  pipelineRunId?: string
  /** Step/node ID within a pipeline. */
  nodeId?: string
}

// ---------------------------------------------------------------------------
// Projected event shapes
// ---------------------------------------------------------------------------

/** Subagent lifecycle event emitted when a subagent starts or finishes. */
export interface SubagentLifecycleEvent {
  type: 'subagent_started' | 'subagent_completed' | 'subagent_failed'
  agentId: string
  agentRole?: string
  ts: number
  /** Only present on subagent_completed. */
  summary?: string
  /** Only present on subagent_failed. */
  error?: string
}

/** A message event scoped to a specific agent. */
export interface AgentMessageEvent {
  type: 'agent_text' | 'agent_tool_call' | 'agent_tool_result'
  agentId: string
  agentRole?: string
  /** Text content (for agent_text). */
  content?: string
  /** Tool name (for agent_tool_call / agent_tool_result). */
  toolName?: string
  /** Tool args (for agent_tool_call). */
  args?: unknown
  /** Tool result (for agent_tool_result). */
  result?: unknown
  ts: number
}

/** A tool invocation record across the whole run. */
export interface ToolInvocationEvent {
  type: 'tool_invocation'
  toolName: string
  args: unknown
  /** Agent that invoked the tool. */
  agentId?: string
  agentRole?: string
  ts: number
}

/** Tool result record across the whole run. */
export interface ToolResultEvent {
  type: 'tool_result_projection'
  toolName: string
  result: unknown
  agentId?: string
  agentRole?: string
  ts: number
}

// ---------------------------------------------------------------------------
// Projection router
// ---------------------------------------------------------------------------

/**
 * Routes AgentStreamEvents to namespace-scoped SSE projections.
 *
 * Wrap an existing SSEWriter and push raw agent events through this router.
 * The router emits enriched, namespaced events while still forwarding raw
 * events (so existing clients that read the flat stream are unaffected when
 * namespace is 'raw').
 */
export class SSEProjectionRouter {
  private namespace: SSENamespace
  private readonly writer: SSEWriter

  constructor(writer: SSEWriter, namespace: SSENamespace = 'raw') {
    this.writer = writer
    this.namespace = namespace
  }

  /** Switch the active namespace. Takes effect on the next push(). */
  setNamespace(ns: SSENamespace): void {
    this.namespace = ns
  }

  getNamespace(): SSENamespace {
    return this.namespace
  }

  /**
   * Push a raw event through the projection router.
   *
   * In `raw` mode this is a pass-through to the underlying writer.
   * In other modes the event is mapped to enriched projection events
   * AND the raw event is still forwarded (for compat).
   */
  push(
    event: { type: string; data: unknown },
    ctx: ProjectionContext = {},
  ): void {
    const ts = Date.now()

    // Always forward raw event for backward compat.
    this.writer.write({ type: event.type, data: event.data })

    if (this.namespace === 'raw') return

    switch (this.namespace) {
      case 'coordinator':
        this.projectCoordinator(event, ctx, ts)
        break
      case 'subagent':
        this.projectSubagent(event, ctx, ts)
        break
      case 'tools':
        this.projectTools(event, ctx, ts)
        break
    }
  }

  /** Emit a subagent lifecycle event. */
  pushSubagentLifecycle(lifecycle: SubagentLifecycleEvent): void {
    this.writer.write({ type: lifecycle.type, data: lifecycle })
  }

  // ---------------------------------------------------------------------------
  // Private projection handlers
  // ---------------------------------------------------------------------------

  private projectCoordinator(
    event: { type: string; data: unknown },
    ctx: ProjectionContext,
    ts: number,
  ): void {
    if (!ctx.agentId || ctx.agentId === 'coordinator') {
      this.emitAgentEvent(event, ctx, ts)
    }
  }

  private projectSubagent(
    event: { type: string; data: unknown },
    ctx: ProjectionContext,
    ts: number,
  ): void {
    if (ctx.agentId) {
      this.emitAgentEvent(event, ctx, ts)
    }
  }

  private projectTools(
    event: { type: string; data: unknown },
    ctx: ProjectionContext,
    ts: number,
  ): void {
    const data = event.data as Record<string, unknown>
    if (event.type === 'tool_call') {
      const invocation: ToolInvocationEvent = {
        type: 'tool_invocation',
        toolName: (data['name'] as string) ?? '',
        args: data['args'],
        agentId: ctx.agentId,
        agentRole: ctx.agentRole,
        ts,
      }
      this.writer.write({ type: 'tool_invocation', data: invocation })
    } else if (event.type === 'tool_result') {
      const result: ToolResultEvent = {
        type: 'tool_result_projection',
        toolName: (data['name'] as string) ?? '',
        result: data['result'],
        agentId: ctx.agentId,
        agentRole: ctx.agentRole,
        ts,
      }
      this.writer.write({ type: 'tool_result_projection', data: result })
    }
  }

  private emitAgentEvent(
    event: { type: string; data: unknown },
    ctx: ProjectionContext,
    ts: number,
  ): void {
    const data = event.data as Record<string, unknown>
    let agentEvent: AgentMessageEvent | undefined

    if (event.type === 'text') {
      agentEvent = {
        type: 'agent_text',
        agentId: ctx.agentId ?? 'unknown',
        agentRole: ctx.agentRole,
        content: (data['content'] as string) ?? '',
        ts,
      }
    } else if (event.type === 'tool_call') {
      agentEvent = {
        type: 'agent_tool_call',
        agentId: ctx.agentId ?? 'unknown',
        agentRole: ctx.agentRole,
        toolName: (data['name'] as string) ?? '',
        args: data['args'],
        ts,
      }
    } else if (event.type === 'tool_result') {
      agentEvent = {
        type: 'agent_tool_result',
        agentId: ctx.agentId ?? 'unknown',
        agentRole: ctx.agentRole,
        toolName: (data['name'] as string) ?? '',
        result: data['result'],
        ts,
      }
    }

    if (agentEvent) {
      this.writer.write({ type: agentEvent.type, data: agentEvent })
    }
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Wrap an SSEWriter with a projection router for the given namespace.
 *
 * Example:
 *   const router = withProjection(writer, 'subagent')
 *   router.push(event, { agentId: 'coder-1', agentRole: 'coder' })
 */
export function withProjection(
  writer: SSEWriter,
  namespace: SSENamespace = 'raw',
): SSEProjectionRouter {
  return new SSEProjectionRouter(writer, namespace)
}
