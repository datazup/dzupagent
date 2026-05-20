import { ToolMessage } from '@langchain/core/messages'
import { ForgeError } from '@dzupagent/core/events'
import type { ToolGovernance } from '@dzupagent/core/tools'
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
  /**
   * DZUPAGENT-AGENT-H-02 — Optional governance reference used by the kernel's
   * approval pre-scan. When supplied AND any tool call in a parallel batch
   * reports `requiresApproval: true`, the kernel downgrades the batch to
   * sequential scheduling. The sequential path then short-circuits on the
   * first `approvalPending` result, guaranteeing that no side-effecting
   * sibling can run before the human-approval gate.
   *
   * This is defense-in-depth: the outer tool-loop already performs the same
   * pre-scan (T-AP-002) before calling the scheduler. Wiring the check at
   * the kernel layer ensures direct consumers of `scheduleToolCalls` (tests,
   * custom orchestrators, future agents-as-tools paths) inherit the same
   * guarantee without needing to replicate the gate themselves.
   *
   * The pre-scan only INSPECTS access for approval classification; the
   * authoritative governance decision (block / approval-emit / audit) still
   * lives in the executor (`runPolicyChecks`). Rate-limit counters in
   * `ToolGovernance.checkAccess` are therefore consumed at most once per
   * scheduled invocation along the approval path (kernel pre-scan +
   * executor pre-flight share the same per-call counter spend that
   * already exists in the loop-level pre-scan).
   */
  toolGovernance?: ToolGovernance
}

/**
 * Narrow tool-call scheduler kernel. It decides ordering/concurrency only;
 * the supplied executor owns governance, validation, timeout, scanning,
 * telemetry, and stuck-detection policy.
 *
 * DZUPAGENT-AGENT-H-02 — In parallel mode the kernel performs an approval
 * pre-scan via `toolGovernance.checkAccess`. If any call in the batch
 * requires human approval, the batch is downgraded to sequential so the
 * first `approvalPending` result short-circuits the rest of the siblings.
 */
export async function scheduleToolCalls(
  toolCalls: ToolCall[],
  options: ToolSchedulerOptions,
  execute: ToolCallExecutor,
): Promise<ToolCallResult[]> {
  const wantsParallel = options.parallelTools === true && toolCalls.length > 1
  if (wantsParallel && hasApprovalRequiredCall(toolCalls, options.toolGovernance)) {
    // Defense-in-depth approval gate: downgrade to serial so the executor's
    // approval pause naturally halts the batch before any side-effecting
    // sibling runs. See ToolSchedulerOptions.toolGovernance for rationale.
    return scheduleSequential(toolCalls, execute)
  }
  return wantsParallel
    ? scheduleParallel(toolCalls, options, execute)
    : scheduleSequential(toolCalls, execute)
}

/**
 * DZUPAGENT-AGENT-H-02 — Classify a parallel batch by approval requirement.
 * Returns true if at least one tool call in the batch is `allowed` but
 * `requiresApproval`. Denied calls (allowed=false) are NOT treated as
 * approval gates here; the executor's `runPolicyChecks` is the authoritative
 * denial site and will surface its own ToolMessage. The pre-scan is purely
 * a classification hook for approval-pause sequencing.
 *
 * Errors thrown by a custom `checkAccess` implementation are swallowed so a
 * mis-behaving governance plugin cannot brick the scheduler — the executor's
 * pre-flight (which re-checks access for every call) is the safety net.
 */
function hasApprovalRequiredCall(
  toolCalls: ToolCall[],
  governance: ToolGovernance | undefined,
): boolean {
  if (!governance) return false
  for (const tc of toolCalls) {
    try {
      const access = governance.checkAccess(tc.name, tc.args)
      if (access.allowed && access.requiresApproval) return true
    } catch {
      // Treat as non-approval; executor will re-check and surface errors.
    }
  }
  return false
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

  const thrown = ordered
    .filter(r => r.thrown !== undefined)
    .map(r => r.thrown)
  if (thrown.length === 1) {
    throw thrown[0]
  }
  if (thrown.length > 1) {
    throw new AggregateError(thrown, 'Tool batch failed')
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
