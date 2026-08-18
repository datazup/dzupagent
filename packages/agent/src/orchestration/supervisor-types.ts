/**
 * Supervisor configuration and result types.
 *
 * Lives separately from `orchestrator.ts` so callers depending only on the
 * supervisor surface do not pull in the full orchestrator implementation.
 */
import type { DzupEventBus } from "@dzupagent/core/events";
import type { BaseSupervisorContract } from "@dzupagent/agent-types";
import type { DzupAgent } from "../agent/dzip-agent.js";
import type { AgentCircuitBreaker } from "./circuit-breaker.js";
import type { OrchestrationMergeStrategy } from "./orchestration-merge-strategy-types.js";
import type { ProviderExecutionPort } from "./provider-adapter/provider-execution-port.js";
import type {
  RoutingPolicy,
  RoutingTaskInput,
} from "./routing-policy-types.js";

/** Start evidence for one real specialist-tool invocation. */
export interface SpecialistInvocationStart {
  /** Stable ID of the specialist whose tool is being invoked. */
  readonly specialistId: string;
  /** Zero-based order in which this run started specialist invocations. */
  readonly invocationIndex: number;
}

/** Completed evidence for one real specialist-tool invocation. */
export interface SpecialistInvocationOutcome extends SpecialistInvocationStart {
  /** Whether the specialist tool invocation returned successfully. */
  readonly success: boolean;
  /** Non-negative elapsed wall-clock duration for the tool invocation. */
  readonly durationMs: number;
  /** Normalized failure text. Absent for successful invocations. */
  readonly error?: string;
}

/**
 * Best-effort lifecycle observer for real specialist-tool invocations.
 *
 * Callback failures are isolated by the supervisor and cannot replace a tool
 * result or exception. Arguments and tool output are deliberately excluded.
 */
export interface SpecialistInvocationObserver {
  onStart?(invocation: SpecialistInvocationStart): unknown;
  onComplete?(outcome: SpecialistInvocationOutcome): unknown;
}

export interface SupervisorConfig extends BaseSupervisorContract<DzupAgent> {
  /** The manager agent that coordinates specialists */
  manager: DzupAgent;
  /** Specialist agents to be exposed as tools to the manager */
  specialists: DzupAgent[];
  /** The task to delegate */
  task: string;
  /** If true, run a lightweight health check on each specialist before exposing it */
  healthCheck?: boolean;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Event bus for structured supervisor routing diagnostics */
  eventBus?: DzupEventBus;
  /**
   * Execution mode for the supervisor.
   * - `'agent'` (default): use DzupAgent for execution
   * - `'provider-adapter'`: route via the injected `providerPort`
   */
  executionMode?: "agent" | "provider-adapter";
  /**
   * Provider execution port for adapter-based execution.
   * Required when `executionMode` is `'provider-adapter'`.
   * Ignored when `executionMode` is `'agent'` or unset.
   */
  providerPort?: ProviderExecutionPort;
  /**
   * Pluggable routing policy for specialist selection.
   * When set, filters/selects specialists before exposing them to the manager.
   */
  routingPolicy?: RoutingPolicy;
  /** Optional stable identity, requirements, and metadata for routing. */
  routingTask?: RoutingTaskInput;
  /**
   * Pluggable merge strategy for combining parallel agent results.
   * Used by the `parallel` method when provided.
   */
  mergeStrategy?: OrchestrationMergeStrategy;
  /**
   * Circuit breaker for excluding unhealthy specialists.
   * When set, specialists with tripped circuits are filtered out.
   */
  circuitBreaker?: AgentCircuitBreaker;
  /**
   * Observe real local specialist-tool calls for this run. Supplying an
   * observer disables synthesized-manager cache reuse so callbacks cannot leak
   * across runs.
   */
  invocationObserver?: SpecialistInvocationObserver;
}

export interface SupervisorResult {
  /** The final text output from the manager */
  content: string;
  /** Which specialist tools were available to the manager */
  availableSpecialists: string[];
  /** Which specialists were filtered out by health check */
  filteredSpecialists: string[];
  /** ID of the routing decision when a routing policy was applied. Undefined for direct selection. */
  routingDecisionId?: string;
  /**
   * Ordered completed invocation evidence when `invocationObserver` was
   * supplied. Absent when local invocation observation was not requested.
   */
  specialistInvocations?: SpecialistInvocationOutcome[];
}

export type MergeFn = (results: string[]) => string | Promise<string>;
