import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  createEventBus,
  createSafetyMonitor,
  ToolGovernance,
  type DzupEventBus,
  type SafetyMonitor,
  type ToolGovernanceConfig,
} from '@dzupagent/core'
import type { ToolPermissionPolicy } from '@dzupagent/agent-types'
import type {
  ArgumentValidator,
  DzupAgentConfig,
  PerToolTimeoutMap,
  ToolExecutionConfig,
  ToolTracer,
} from './agent-types.js'

export interface ProductionToolPermissionOptions {
  /**
   * Tools this preset may invoke when no custom permission policy is supplied.
   * Omit or pass an empty list to default-deny all tool calls.
   */
  allowedToolNames?: readonly string[]
  /** Custom policy. Wins over allowedToolNames when supplied. */
  permissionPolicy?: ToolPermissionPolicy
}

export interface ProductionToolGovernancePresetOptions extends ProductionToolPermissionOptions {
  /** Agent id used for permission checks and lifecycle telemetry. */
  agentId: string
  /** Durable run id propagated to canonical tool lifecycle events. */
  runId: string
  /** Tools used to derive default per-tool timeouts and allowlists. */
  tools?: readonly StructuredToolInterface[]
  /** Shared event bus. If omitted, the preset creates one. */
  eventBus?: DzupEventBus
  /** Safety monitor. If omitted, the preset creates one with built-in rules. */
  safetyMonitor?: SafetyMonitor
  /** Tool governance instance or config. If omitted, a restrictive instance is created. */
  governance?: ToolGovernance | ToolGovernanceConfig
  /** Tools blocked before any permission or invocation step. */
  blockedToolNames?: readonly string[]
  /** Tools that require human approval before invocation. */
  approvalRequiredToolNames?: readonly string[]
  /** Per-tool rate limits forwarded into ToolGovernance. */
  rateLimits?: Record<string, number>
  /** Per-tool timeouts. Wins over defaultToolTimeoutMs for matching names. */
  timeouts?: PerToolTimeoutMap
  /** Timeout assigned to each named tool not present in timeouts. Defaults to 30s. */
  defaultToolTimeoutMs?: number
  /** Argument validation config. Defaults to strict validation without repair. */
  argumentValidator?: ArgumentValidator
  /** Optional tracer used by the tool loop. */
  tracer?: ToolTracer
  /** Set false only when upstream scanning already occurred. Defaults to true. */
  scanToolResults?: boolean
}

export interface ProductionToolGovernancePreset {
  eventBus: DzupEventBus
  safetyMonitor: SafetyMonitor
  governance: ToolGovernance
  permissionPolicy: ToolPermissionPolicy
  toolExecution: ToolExecutionConfig
}

/**
 * Create an opt-in production tool governance preset for DzupAgent.
 *
 * The preset composes the existing primitives into one fail-closed
 * configuration bundle:
 * - canonical lifecycle telemetry via eventBus + agentId + runId
 * - ToolGovernance block/approval/rate-limit checks
 * - permission policy, default-deny when no allowlist/custom policy exists
 * - built-in safety monitor with fail-closed scanner behavior
 * - per-tool timeouts and argument validation
 * - optional tracer propagation
 */
export function createProductionToolGovernancePreset(
  options: ProductionToolGovernancePresetOptions,
): ProductionToolGovernancePreset {
  const eventBus = options.eventBus ?? createEventBus()
  const safetyMonitor = options.safetyMonitor ?? createSafetyMonitor({ eventBus })
  const governance = resolveGovernance(options)
  const permissionPolicy =
    options.permissionPolicy ?? createAllowlistPermissionPolicy(resolveAllowedTools(options))
  const timeouts = resolveTimeouts(options)

  const toolExecution: ToolExecutionConfig = {
    governance,
    safetyMonitor,
    scanToolResults: options.scanToolResults ?? true,
    scanFailureMode: 'fail-closed',
    timeouts,
    argumentValidator: options.argumentValidator ?? { autoRepair: false },
    permissionPolicy,
    agentId: options.agentId,
    runId: options.runId,
    ...(options.tracer !== undefined ? { tracer: options.tracer } : {}),
  }

  return {
    eventBus,
    safetyMonitor,
    governance,
    permissionPolicy,
    toolExecution,
  }
}

/**
 * Convenience helper for consumers that want to apply the production preset
 * directly to a DzupAgentConfig object.
 */
export function withProductionToolGovernancePreset<T extends DzupAgentConfig>(
  config: T,
  options: Omit<ProductionToolGovernancePresetOptions, 'agentId' | 'tools'> & {
    agentId?: string
    tools?: readonly StructuredToolInterface[]
  },
): T & { eventBus: DzupEventBus; toolExecution: ToolExecutionConfig } {
  const preset = createProductionToolGovernancePreset({
    ...options,
    agentId: options.agentId ?? config.id,
    tools: options.tools ?? config.tools,
    eventBus: options.eventBus ?? config.eventBus,
  })

  return {
    ...config,
    eventBus: preset.eventBus,
    toolExecution: preset.toolExecution,
  }
}

function resolveGovernance(options: ProductionToolGovernancePresetOptions): ToolGovernance {
  if (options.governance instanceof ToolGovernance) {
    return options.governance
  }

  const config = options.governance
  const existingBlocked = typeof config === 'object' ? config.blockedTools : undefined
  const existingApproval = typeof config === 'object' ? config.approvalRequired : undefined
  const existingRateLimits = typeof config === 'object' ? config.rateLimits : undefined

  return new ToolGovernance({
    ...(typeof config === 'object' ? config : {}),
    blockedTools: [
      ...(existingBlocked ?? []),
      ...(options.blockedToolNames ?? []),
    ],
    approvalRequired: [
      ...(existingApproval ?? []),
      ...(options.approvalRequiredToolNames ?? []),
    ],
    rateLimits: {
      ...(existingRateLimits ?? {}),
      ...(options.rateLimits ?? {}),
    },
  })
}

function resolveAllowedTools(options: ProductionToolGovernancePresetOptions): readonly string[] {
  if (options.allowedToolNames !== undefined) return options.allowedToolNames
  return options.tools?.map(tool => tool.name) ?? []
}

export function createAllowlistPermissionPolicy(
  allowedToolNames: readonly string[],
): ToolPermissionPolicy {
  const allowed = new Set(allowedToolNames)
  return {
    hasPermission: (_callerAgentId, toolName) => allowed.has(toolName),
  }
}

function resolveTimeouts(options: ProductionToolGovernancePresetOptions): PerToolTimeoutMap {
  const timeoutMs = options.defaultToolTimeoutMs ?? 30_000
  const timeouts: PerToolTimeoutMap = {}
  for (const tool of options.tools ?? []) {
    timeouts[tool.name] = timeoutMs
  }
  return { ...timeouts, ...(options.timeouts ?? {}) }
}
