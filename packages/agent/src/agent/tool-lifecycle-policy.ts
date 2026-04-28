import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  requireTerminalToolExecutionRunId,
  type DzupEventBus,
  type ForgeErrorCode,
  type ToolGovernance,
} from '@dzupagent/core'
import {
  formatSchemaHint,
  validateAndRepairToolArgs,
  type ToolArgValidatorConfig,
} from './tool-arg-validator.js'
import {
  isToolCancellationError,
  isToolTimeoutError,
  ToolCancellationError,
  ToolTimeoutError,
} from './tool-timeout-error.js'

export interface ToolLifecyclePolicyContext {
  eventBus?: DzupEventBus
  toolGovernance?: ToolGovernance
  agentId?: string
  runId?: string
}

export type ToolLifecycleStatus =
  | 'success'
  | 'error'
  | 'timeout'
  | 'denied'
  | 'cancel_requested'
  | 'cancelled'

export interface ToolCallArgs {
  name: string
  args: Record<string, unknown>
}

export function extractInputMetadataKeys(input: unknown): string[] {
  if (input == null || typeof input !== 'object') return []
  if (Array.isArray(input)) return []
  return Object.keys(input as Record<string, unknown>)
}

export function statusFromError(
  err: unknown,
): Extract<ToolLifecycleStatus, 'error' | 'timeout' | 'cancelled'> {
  if (isToolTimeoutError(err)) return 'timeout'
  if (isToolCancellationError(err)) return 'cancelled'
  return 'error'
}

export function resolveValidatorConfig(
  cfg: boolean | ToolArgValidatorConfig | undefined,
): ToolArgValidatorConfig | null {
  if (!cfg) return null
  if (cfg === true) return { autoRepair: true }
  return cfg
}

export function extractJsonSchema(
  tool: StructuredToolInterface,
): Record<string, unknown> | null {
  const schema = (tool as StructuredToolInterface & { schema?: unknown }).schema
  if (!schema) return null

  if (typeof schema === 'object' && schema !== null) {
    const s = schema as Record<string, unknown>
    if (s.properties || s.type) return s

    const zodSchema = schema as { jsonSchema?: () => Record<string, unknown> }
    if (typeof zodSchema.jsonSchema === 'function') {
      try {
        return zodSchema.jsonSchema() as Record<string, unknown>
      } catch {
        // Ignore schema conversion failures; callers will skip validation.
      }
    }
  }
  return null
}

export function maybeValidateArgs(
  toolCall: ToolCallArgs,
  tool: StructuredToolInterface,
  validatorCfg: ToolArgValidatorConfig | null,
): { args: Record<string, unknown>; validationError?: string } {
  if (!validatorCfg) return { args: toolCall.args }

  const jsonSchema = extractJsonSchema(tool)
  if (!jsonSchema) return { args: toolCall.args }

  const result = validateAndRepairToolArgs(toolCall.args, jsonSchema, validatorCfg)

  if (result.valid && result.repairedArgs) {
    return { args: result.repairedArgs as Record<string, unknown> }
  }

  if (!result.valid) {
    const hint = formatSchemaHint(jsonSchema)
    const errMsg = `Validation failed for tool "${toolCall.name}": ${result.errors.join('; ')}.\n${hint}`
    return { args: toolCall.args, validationError: errMsg }
  }

  return { args: toolCall.args }
}

export function emitToolCalled(
  context: ToolLifecyclePolicyContext | undefined,
  args: {
    toolName: string
    toolCallId: string
    input: Record<string, unknown>
    inputMetadataKeys: string[]
  },
): void {
  if (!context) return
  const { toolName, toolCallId, inputMetadataKeys } = args
  try {
    context.eventBus?.emit({
      type: 'tool:called',
      toolName,
      toolCallId,
      inputMetadataKeys,
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      ...(context.runId !== undefined
        ? { runId: context.runId, executionRunId: context.runId }
        : {}),
    } as never)
  } catch {
    // Telemetry must never abort the loop.
  }

  if (context.toolGovernance) {
    const auditEntry = {
      toolName,
      input: undefined,
      inputMetadataKeys,
      callerAgent: context.agentId ?? 'unknown',
      timestamp: Date.now(),
      allowed: true,
    }
    void context.toolGovernance
      .audit(auditEntry)
      .catch(() => {
        /* non-fatal */
      })
  }
}

export function emitToolResult(
  context: ToolLifecyclePolicyContext | undefined,
  args: {
    toolName: string
    toolCallId: string
    durationMs: number
    inputMetadataKeys: string[]
    output: unknown
  },
): void {
  if (!context) return
  const { toolName, toolCallId, durationMs, inputMetadataKeys, output } = args
  try {
    const executionRunId = requireTerminalToolExecutionRunId({
      eventType: 'tool:result',
      toolName,
      executionRunId: context.runId,
    })
    context.eventBus?.emit({
      type: 'tool:result',
      toolName,
      durationMs,
      toolCallId,
      inputMetadataKeys,
      status: 'success',
      executionRunId,
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      ...(context.runId !== undefined ? { runId: context.runId } : {}),
    } as never)
  } catch {
    // Telemetry must never abort the loop.
  }

  if (context.toolGovernance) {
    void context.toolGovernance
      .auditResult({
        toolName,
        output,
        callerAgent: context.agentId ?? 'unknown',
        durationMs,
        success: true,
        timestamp: Date.now(),
      })
      .catch(() => {
        /* non-fatal */
      })
  }
}

export function emitToolError(
  context: ToolLifecyclePolicyContext | undefined,
  args: {
    toolName: string
    toolCallId: string
    durationMs: number
    inputMetadataKeys: string[]
    errorCode: ForgeErrorCode
    errorMessage: string
    status: Exclude<ToolLifecycleStatus, 'success'>
  },
): void {
  if (!context) return
  const {
    toolName,
    toolCallId,
    durationMs,
    inputMetadataKeys,
    errorCode,
    errorMessage,
    status,
  } = args
  try {
    const executionRunId = requireTerminalToolExecutionRunId({
      eventType: 'tool:error',
      toolName,
      executionRunId: context.runId,
    })
    context.eventBus?.emit({
      type: 'tool:error',
      toolName,
      errorCode,
      message: errorMessage,
      errorMessage,
      durationMs,
      toolCallId,
      inputMetadataKeys,
      status,
      executionRunId,
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      ...(context.runId !== undefined ? { runId: context.runId } : {}),
    } as never)
  } catch {
    // Telemetry must never abort the loop.
  }

  if (context.toolGovernance) {
    void context.toolGovernance
      .auditResult({
        toolName,
        output: errorMessage,
        callerAgent: context.agentId ?? 'unknown',
        durationMs,
        success: false,
        timestamp: Date.now(),
      })
      .catch(() => {
        /* non-fatal */
      })
  }
}

export function emitToolCancellationRequested(
  context: ToolLifecyclePolicyContext | undefined,
  args: {
    toolName: string
    toolCallId: string
    inputMetadataKeys: string[]
    reason: 'timeout' | 'run_cancelled'
    timeoutMs?: number
  },
): void {
  if (!context) return
  const { toolName, toolCallId, inputMetadataKeys, reason, timeoutMs } = args
  try {
    context.eventBus?.emit({
      type: 'tool:cancel_requested',
      toolName,
      toolCallId,
      inputMetadataKeys,
      status: 'cancel_requested',
      reason,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
      ...(context.runId !== undefined
        ? { runId: context.runId, executionRunId: context.runId }
        : {}),
    } as never)
  } catch {
    // Telemetry must never abort the loop.
  }
}

export interface ToolInvocationContext {
  signal: AbortSignal
}

export type CancellableToolInvoker<T> = (context: ToolInvocationContext) => Promise<T>

export async function invokeWithOptionalTimeout<T>(
  toolName: string,
  timeoutMs: number | undefined,
  invoke: CancellableToolInvoker<T>,
  options: {
    signal?: AbortSignal
    onCancelRequested?: (reason: 'timeout' | 'run_cancelled') => void
  } = {},
): Promise<T> {
  if (options.signal?.aborted) {
    options.onCancelRequested?.('run_cancelled')
    throw new ToolCancellationError(toolName)
  }

  const controller = new AbortController()
  const signal = controller.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let parentAbortHandler: (() => void) | undefined
  let abortKind: 'timeout' | 'run_cancelled' | undefined

  const failForAbort = (reason: 'timeout' | 'run_cancelled'): Error => {
    return reason === 'timeout'
      ? new ToolTimeoutError(toolName, timeoutMs ?? 0)
      : new ToolCancellationError(toolName)
  }

  const abortPromise = new Promise<never>((_, reject) => {
    const requestAbort = (reason: 'timeout' | 'run_cancelled') => {
      if (abortKind !== undefined) return
      abortKind = reason
      options.onCancelRequested?.(reason)
      controller.abort(failForAbort(reason))
      reject(failForAbort(reason))
    }

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => requestAbort('timeout'), timeoutMs)
    }

    if (options.signal) {
      parentAbortHandler = () => requestAbort('run_cancelled')
      options.signal.addEventListener('abort', parentAbortHandler, { once: true })
    }
  })

  try {
    const invokePromise = invoke({ signal }).catch((err: unknown) => {
      if (abortKind !== undefined) {
        throw failForAbort(abortKind)
      }
      throw err
    })
    return await Promise.race([invokePromise, abortPromise])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (options.signal && parentAbortHandler) {
      options.signal.removeEventListener('abort', parentAbortHandler)
    }
  }
}
