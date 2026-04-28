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
import { isToolTimeoutError, ToolTimeoutError } from './tool-timeout-error.js'

export interface ToolLifecyclePolicyContext {
  eventBus?: DzupEventBus
  toolGovernance?: ToolGovernance
  agentId?: string
  runId?: string
}

export type ToolLifecycleStatus = 'success' | 'error' | 'timeout' | 'denied'

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
): Extract<ToolLifecycleStatus, 'error' | 'timeout'> {
  return isToolTimeoutError(err) ? 'timeout' : 'error'
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
  const { toolName, toolCallId, input, inputMetadataKeys } = args
  try {
    context.eventBus?.emit({
      type: 'tool:called',
      toolName,
      input,
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
    void context.toolGovernance
      .audit({
        toolName,
        input,
        callerAgent: context.agentId ?? 'unknown',
        timestamp: Date.now(),
        allowed: true,
      })
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

export async function invokeWithOptionalTimeout<T>(
  toolName: string,
  timeoutMs: number | undefined,
  invoke: () => Promise<T>,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return invoke()
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ToolTimeoutError(toolName, timeoutMs)),
      timeoutMs,
    )
  })

  try {
    return await Promise.race([invoke(), timeoutPromise])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
