import { ToolMessage } from '@langchain/core/messages'
import { ForgeError } from '@dzupagent/core'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import type {
  ToolCall,
  ToolCallExecutor,
  ToolCallResult,
} from './contracts.js'

export interface ToolSchedulerOptions {
  parallelTools?: boolean
  maxParallelTools?: number
  signal?: AbortSignal
  agentId?: string
  toolPermissionPolicy?: ToolPermissionPolicy
}

/**
 * Narrow tool-call scheduler kernel. It decides ordering/concurrency only;
 * the supplied executor owns governance, validation, timeout, scanning,
 * telemetry, and stuck-detection policy.
 */
export async function scheduleToolCalls(
  toolCalls: ToolCall[],
  options: ToolSchedulerOptions,
  execute: ToolCallExecutor,
): Promise<ToolCallResult[]> {
  return options.parallelTools && toolCalls.length > 1
    ? scheduleParallel(toolCalls, options, execute)
    : scheduleSequential(toolCalls, execute)
}

async function scheduleSequential(
  toolCalls: ToolCall[],
  execute: ToolCallExecutor,
): Promise<ToolCallResult[]> {
  const out: ToolCallResult[] = []
  for (let i = 0; i < toolCalls.length; i++) {
    const r = await execute(toolCalls[i]!, i)
    out.push(r)
    if (r.approvalPending || r.stuckBreak) break
  }
  return out
}

async function scheduleParallel(
  toolCalls: ToolCall[],
  options: ToolSchedulerOptions,
  execute: ToolCallExecutor,
): Promise<ToolCallResult[]> {
  // Pre-validation: check permissions for ALL tool calls before executing any.
  // This preserves the existing parallel-path contract that no sibling tool
  // fires when at least one call is denied.
  if (options.toolPermissionPolicy && options.agentId) {
    for (const tc of toolCalls) {
      if (!options.toolPermissionPolicy.hasPermission(options.agentId, tc.name)) {
        throw new ForgeError({
          code: 'TOOL_PERMISSION_DENIED',
          message: `Tool "${tc.name}" is not accessible to agent "${options.agentId}"`,
          context: { agentId: options.agentId, toolName: tc.name },
        })
      }
    }
  }

  const maxParallel = Math.max(1, options.maxParallelTools ?? 10)
  let running = 0
  const waiting: Array<() => void> = []

  function acquire(): Promise<void> {
    if (running < maxParallel) {
      running++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiting.push(resolve)
    })
  }

  function release(): void {
    const next = waiting.shift()
    if (next) {
      next()
    } else {
      running--
    }
  }

  async function runOne(
    tc: ToolCall,
    index: number,
  ): Promise<{ index: number; result: ToolCallResult; thrown?: unknown }> {
    if (options.signal?.aborted) {
      return {
        index,
        result: abortedToolResult(tc, index),
      }
    }

    await acquire()
    try {
      if (options.signal?.aborted) {
        return {
          index,
          result: abortedToolResult(tc, index),
        }
      }
      const result = await execute(tc, index)
      return { index, result }
    } catch (err) {
      const toolCallId = tc.id ?? `call_${Date.now()}_${index}`
      return {
        index,
        thrown: err,
        result: {
          message: new ToolMessage({
            content: `Error executing tool "${tc.name}": ${err instanceof Error ? err.message : String(err)}`,
            tool_call_id: toolCallId,
            name: tc.name,
          }),
        },
      }
    } finally {
      release()
    }
  }

  const settled = await Promise.allSettled(
    toolCalls.map((tc, idx) => runOne(tc, idx)),
  )

  const ordered: Array<{ index: number; result: ToolCallResult; thrown?: unknown }> = []
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!
    if (outcome.status === 'fulfilled') {
      ordered.push(outcome.value)
    } else {
      const tc = toolCalls[i]!
      const toolCallId = tc.id ?? `call_${Date.now()}_${i}`
      ordered.push({
        index: i,
        thrown: outcome.reason,
        result: {
          message: new ToolMessage({
            content: `Error executing tool "${tc.name}": ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
            tool_call_id: toolCallId,
            name: tc.name,
          }),
        },
      })
    }
  }

  ordered.sort((a, b) => a.index - b.index)

  const firstThrown = ordered.find(r => r.thrown !== undefined)
  if (firstThrown) {
    throw firstThrown.thrown
  }

  return ordered.map(r => r.result)
}

function abortedToolResult(tc: ToolCall, index: number): ToolCallResult {
  const toolCallId = tc.id ?? `call_${Date.now()}_${index}`
  return {
    message: new ToolMessage({
      content: `Error executing tool "${tc.name}": Aborted`,
      tool_call_id: toolCallId,
      name: tc.name,
    }),
  }
}
