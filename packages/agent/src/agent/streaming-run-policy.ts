/**
 * Tool-execution policy resolution for the streaming run loop.
 *
 * Extracted from `streaming-run.ts` (MC-026b-1). Resolves the public
 * `toolExecution` config bundle into the internal
 * {@link StreamingToolPolicyOptions} shape so the streaming path enforces
 * the same governance, permission, validation, timeout, safety, and
 * tracing controls as `executeGenerateRun` (MJ-AGENT-02).
 */

import type { GenerateOptions } from './agent-types.js'
import type { StreamingToolPolicyOptions } from './run-engine.js'
import type { StreamRunContext } from './streaming-run-types.js'

/**
 * Build a {@link StreamingToolPolicyOptions} from the agent's
 * `toolExecution` config and the active run options. Returns `undefined`
 * when the agent did not opt in to the public tool-execution surface so
 * the legacy "lite" executor behaviour is preserved bit-for-bit.
 */
export function buildStreamingToolPolicy(
  ctx: StreamRunContext,
  options?: GenerateOptions,
): StreamingToolPolicyOptions | undefined {
  const toolExec = ctx.config.toolExecution
  if (!toolExec) return undefined

  const resolvedSafetyMonitor = toolExec.safetyMonitor ?? toolExec.resultScanner

  return {
    ...(toolExec.governance !== undefined
      ? { toolGovernance: toolExec.governance }
      : {}),
    ...(toolExec.permissionPolicy !== undefined
      ? { toolPermissionPolicy: toolExec.permissionPolicy }
      : {}),
    ...(toolExec.argumentValidator !== undefined
      ? { validateToolArgs: toolExec.argumentValidator }
      : {}),
    ...(toolExec.timeouts !== undefined
      ? { toolTimeouts: toolExec.timeouts }
      : {}),
    ...(resolvedSafetyMonitor !== undefined
      ? { safetyMonitor: resolvedSafetyMonitor }
      : {}),
    ...(toolExec.scanToolResults !== undefined
      ? { scanToolResults: toolExec.scanToolResults }
      : {}),
    ...(toolExec.scanFailureMode !== undefined
      ? { scanFailureMode: toolExec.scanFailureMode }
      : {}),
    // MC-3 — forward the prompt-injection guardrail so stream() wraps tool
    // results identically to generate() (parity, MJ-AGENT-02).
    ...(toolExec.promptInjectionGuard !== undefined
      ? { promptInjectionGuard: toolExec.promptInjectionGuard }
      : {}),
    ...(toolExec.wrapToolResults !== undefined
      ? { wrapToolResults: toolExec.wrapToolResults }
      : {}),
    ...(toolExec.tracer !== undefined ? { tracer: toolExec.tracer } : {}),
    // agentId / runId mirror the executeGenerateRun fallback: when
    // `toolExecution` is provided, fall back to the surrounding agent id
    // so canonical lifecycle events carry provenance.
    agentId: toolExec.agentId ?? ctx.agentId,
    ...(toolExec.runId !== undefined ? { runId: toolExec.runId } : {}),
    // Route policy/lifecycle events to the same bus the agent uses for
    // `tool:latency` / `llm:invoked`, only when `toolExecution` is
    // configured (preserves the pre-MJ-AGENT-02 surface for unconfigured
    // callers).
    ...(ctx.config.eventBus !== undefined
      ? { eventBus: ctx.config.eventBus }
      : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  }
}
