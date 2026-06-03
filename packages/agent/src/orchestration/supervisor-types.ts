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
import type { RoutingPolicy } from "./routing-policy-types.js";

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
}

export type MergeFn = (results: string[]) => string | Promise<string>;
