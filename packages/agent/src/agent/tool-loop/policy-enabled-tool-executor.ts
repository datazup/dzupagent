import { ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { ForgeError } from '@dzupagent/core/events'
import {
  emitToolCalled,
  emitToolError,
  emitToolResult,
  extractInputMetadataKeys,
} from '../tool-lifecycle-policy.js'
import type { ToolLoopConfig } from '../tool-loop.js'
import type { StatGetter, ToolCall, ToolCallResult } from './contracts.js'
import { omitUndefined } from '../../utils/exact-optional.js'
import { runPolicyChecks } from './policy-checks.js'
import { invokeToolWithRetry } from './tool-invoker.js'
import {
  applyOutputValidation,
  applySafetyScan,
  endSpan,
  evaluateStuck,
  handleToolError,
  maybeEmitCheckpointEvent,
} from './result-pipeline.js'

export interface PolicyEnabledToolExecutorParams {
  toolMap: Map<string, StructuredToolInterface>
  config: ToolLoopConfig
  getOrCreateStat: StatGetter
}

/**
 * Policy-enabled single-tool execution stage.
 *
 * The scheduler kernel calls this stage for each chosen tool call. This stage
 * owns governance, permissions, budget blocks, argument validation, timeout,
 * safety scanning, token-result callbacks, stuck detection, telemetry, and
 * tracing so sequential, parallel, and future streaming schedulers can reuse
 * the same execution contract.
 *
 * Internally the stage delegates to three focused modules:
 *   - `policy-checks.ts`    — permission / governance / budget / validation
 *   - `tool-invoker.ts`     — timeout + retry + TOCTOU re-check + invoke
 *   - `result-pipeline.ts`  — safety scan, output validation, error handling,
 *                             span/checkpoint telemetry, stuck evaluation
 */
export async function executePolicyEnabledToolCall(
  tc: ToolCall,
  params: PolicyEnabledToolExecutorParams,
): Promise<ToolCallResult> {
  const { toolMap, config, getOrCreateStat } = params
  const toolName = tc.name
  const toolCallId = tc.id ?? `call_${Date.now()}`
  const inputMetadataKeys = extractInputMetadataKeys(tc.args)

  const checks = runPolicyChecks(tc, toolMap, config, toolCallId, inputMetadataKeys)
  if (checks.thrown) throw checks.thrown
  if (checks.result) return checks.result
  // After `runPolicyChecks` succeeds these fields are guaranteed present.
  const tool = checks.tool!
  const validatedArgs = checks.validatedArgs!
  const validatedKeys = checks.validatedKeys!

  emitToolCalled(config, {
    toolName,
    toolCallId,
    input: validatedArgs,
    inputMetadataKeys: validatedKeys,
  })
  config.onToolCall?.(toolName, validatedArgs)

  const stat = getOrCreateStat(toolName)
  const startMs = Date.now()
  let errorMsg: string | undefined
  let message: ToolMessage
  const inputSize = JSON.stringify(validatedArgs).length
  const span = config.tracer?.startToolSpan(toolName, { inputSize })

  try {
    const result = await invokeToolWithRetry({
      tool,
      toolName,
      toolCallId,
      validatedArgs,
      validatedKeys,
      config,
    })
    const rawResultStr = typeof result === 'string' ? result : JSON.stringify(result)
    const transformedStr = config.transformToolResult
      ? await config.transformToolResult(toolName, validatedArgs, rawResultStr)
      : rawResultStr

    const safetyOutcome = applySafetyScan(transformedStr, {
      toolName,
      toolCallId,
      validatedKeys,
      startMs,
      span,
      config,
      stat,
    })
    if (safetyOutcome.shortCircuit) {
      return { message: safetyOutcome.shortCircuit.message }
    }
    const resultStr = safetyOutcome.resultStr

    applyOutputValidation(resultStr, toolName, toolCallId, config)

    message = new ToolMessage({
      content: resultStr,
      tool_call_id: toolCallId,
      name: toolName,
    })
    config.onToolResult?.(toolName, resultStr)
    emitToolResult(config, {
      toolName,
      toolCallId,
      durationMs: Date.now() - startMs,
      inputMetadataKeys: validatedKeys,
      output: resultStr,
    })
    maybeEmitCheckpointEvent(config, toolName, result ?? resultStr)
    endSpan(span, {
      durationMs: Date.now() - startMs,
      outputSize: resultStr.length,
    })
  } catch (err: unknown) {
    // REC-M-06 — When the issuance-time permission check denies a tool,
    // the helper throws a ForgeError(TOOL_PERMISSION_DENIED) shaped to
    // match the pre-flight site. Surface it the same way pre-flight does:
    // emit `tool:error` (status=denied) and re-throw past the retry loop
    // and out of this function. This preserves the contract that
    // permission denials terminate the call, never produce a tool-error
    // ToolMessage, and never count as an "error" in tool stats.
    if (
      err instanceof ForgeError &&
      err.code === 'TOOL_PERMISSION_DENIED' &&
      err.context?.['phase'] === 'issuance'
    ) {
      emitToolError(config, {
        toolName,
        toolCallId,
        durationMs: Date.now() - startMs,
        inputMetadataKeys: validatedKeys,
        errorCode: 'TOOL_PERMISSION_DENIED',
        errorMessage: err.message,
        status: 'denied',
      })
      if (span) {
        try {
          span.setAttribute('durationMs', Date.now() - startMs)
          config.tracer?.endSpanWithError(span, err)
        } catch {
          // Tracer failures must not abort the tool loop.
        }
      }
      throw err
    }
    const handled = handleToolError(err, {
      toolName,
      toolCallId,
      validatedKeys,
      startMs,
      span,
      config,
      stat,
    })
    message = handled.message
    errorMsg = handled.errorMsg
  }

  const durationMs = Date.now() - startMs
  stat.calls++
  stat.totalMs += durationMs
  config.onToolLatency?.(toolName, durationMs, errorMsg)

  const stuck = evaluateStuck(toolName, tc.args, toolCallId, errorMsg, config)
  return omitUndefined({
    message,
    stuckNudge: stuck.stuckNudge,
    stuckBreak: stuck.stuckBreak,
    stuckToolName: stuck.stuckToolName,
    stuckReason: stuck.stuckReason,
  })
}
