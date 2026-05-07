/**
 * Dev tool-governance preset.
 *
 * Companion to {@link createProductionToolGovernancePreset} that opts back
 * into the legacy permissive `scanFailureMode: 'fail-open'` behavior.
 *
 * Background (QF-05): the runtime default for `scanFailureMode` was changed
 * from `fail-open` to `fail-closed` so that a crashing safety scanner cannot
 * silently leak tool output. Production presets pin `fail-closed` already.
 * Local development, recorded fixtures, and tests that need to observe a
 * scanner failure without aborting the loop should explicitly opt in by
 * either:
 *
 * 1. Calling {@link createDevToolGovernancePreset} (or
 *    {@link withDevToolGovernancePreset}) to receive a {@link
 *    ToolExecutionConfig} bundle with the legacy `fail-open` mode pinned, or
 * 2. Setting `toolExecution.scanFailureMode = 'fail-open'` directly.
 *
 * Do NOT use this preset in production. It exists exclusively to recover the
 * pre-QF-05 behavior for local debugging and explicit test scenarios.
 */

import type { StructuredToolInterface } from '@langchain/core/tools'
import type { DzupEventBus } from '@dzupagent/core/events'
import type { SafetyMonitor } from '@dzupagent/core/security'
import type { ToolGovernance, ToolGovernanceConfig } from '@dzupagent/core/tools'
import type {
  ArgumentValidator,
  DzupAgentConfig,
  PerToolTimeoutMap,
  ToolExecutionConfig,
  ToolTracer,
} from '../agent/agent-types.js'
import {
  createProductionToolGovernancePreset,
  type ProductionToolPermissionOptions,
} from '../agent/production-tool-governance-preset.js'
import { omitUndefined } from '../utils/exact-optional.js'

export interface DevToolGovernancePresetOptions extends ProductionToolPermissionOptions {
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
  /** Tool governance instance or config. If omitted, a permissive instance is created. */
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

export interface DevToolGovernancePreset {
  eventBus: DzupEventBus
  safetyMonitor: SafetyMonitor
  governance: ToolGovernance
  toolExecution: ToolExecutionConfig
}

/**
 * Build a development tool-governance preset with `scanFailureMode` pinned to
 * `fail-open`.
 *
 * Internally re-uses {@link createProductionToolGovernancePreset} for all
 * other policy decisions (permission policy, timeouts, governance config,
 * argument validation) and only overrides `scanFailureMode` so callers retain
 * the same hardening footprint they would get in production — minus the
 * scanner-failure withholding behavior.
 */
export function createDevToolGovernancePreset(
  options: DevToolGovernancePresetOptions,
): DevToolGovernancePreset {
  const production = createProductionToolGovernancePreset(options)

  const toolExecution: ToolExecutionConfig = {
    ...production.toolExecution,
    scanFailureMode: 'fail-open',
  }

  return {
    eventBus: production.eventBus,
    safetyMonitor: production.safetyMonitor,
    governance: production.governance,
    toolExecution,
  }
}

/**
 * Convenience helper that applies the dev preset to an existing
 * {@link DzupAgentConfig}. Mirrors `withProductionToolGovernancePreset` but
 * substitutes the dev `fail-open` value.
 */
export function withDevToolGovernancePreset<T extends DzupAgentConfig>(
  config: T,
  options: Omit<DevToolGovernancePresetOptions, 'agentId' | 'tools'> & {
    agentId?: string
    tools?: readonly StructuredToolInterface[]
  },
): T & { eventBus: DzupEventBus; toolExecution: ToolExecutionConfig } {
  const preset = createDevToolGovernancePreset(omitUndefined({
    ...options,
    agentId: options.agentId ?? config.id,
    tools: options.tools ?? config.tools,
    eventBus: options.eventBus ?? config.eventBus,
  }))

  return {
    ...config,
    eventBus: preset.eventBus,
    toolExecution: preset.toolExecution,
  }
}
