/**
 * Team coordination pattern — strategy contract for `TeamRuntime`.
 *
 * `TeamRuntime` owns the lifecycle (phase transitions, OTel span, event
 * emission, policy validation, circuit-breaker bookkeeping) and delegates
 * the actual participant scheduling + merge logic to a `TeamPattern`.
 *
 * Each of the five coordinator patterns
 * (`supervisor` | `contract_net` | `blackboard` | `peer_to_peer` | `council`)
 * is implemented as a focused strategy module under `./patterns/` that
 * specialises the `BaseTeamCoordinationContract` from
 * `@dzupagent/agent-types` with the concrete agent-side context and result
 * types.
 */

import type { BaseTeamCoordinationContract } from "@dzupagent/agent-types";
import type { KeyedCircuitBreaker } from "@dzupagent/core/llm";
import type { DzupEventBus } from "@dzupagent/core/events";
import type { BidEvaluationStrategy } from "../../contract-net/contract-net-types.js";
import type {
  CoordinatorPattern,
  ParticipantDefinition,
  TeamDefinition,
} from "../team-definition.js";
import type { TeamCheckpoint } from "../team-checkpoint.js";
import type { TeamPolicies } from "../team-policy.js";
import type {
  SharedWorkspace,
  TeamRunResult,
  TeamSpawnedAgent,
} from "../team-workspace.js";
import type { TeamOTelSpanLike } from "../team-otel-types.js";

/**
 * Resolved participant + spawned agent pair, surfaced to patterns by the
 * runtime so they don't have to re-resolve participants themselves.
 */
export interface ResolvedParticipant {
  participant: ParticipantDefinition;
  spawned: TeamSpawnedAgent;
}

/**
 * Hook surface a pattern uses to ask the runtime to emit lifecycle events
 * and update circuit-breaker state. Centralising these hooks keeps
 * patterns free of direct event-bus / breaker plumbing.
 */
export interface TeamPatternHooks {
  /** Emit a `participant_started` lifecycle event. */
  emitParticipantStart(participant: ParticipantDefinition): void;
  /**
   * Emit a `participant_completed` lifecycle event AND update the
   * circuit-breaker state on the runtime (success → record success,
   * failure → record failure + maybe trip).
   */
  emitParticipantComplete(
    participant: ParticipantDefinition,
    success: boolean,
    durationMs: number,
    error?: string
  ): void;
  /** Emit a `policy_applied` event for the governance/judgeModel knob. */
  emitPolicyApplied(policyGroup: "governance", policyField: "judgeModel"): void;
}

/**
 * Runtime-only (non-serializable) contract-net knobs.
 *
 * Declarative contract-net configuration belongs on `TeamPolicies.contractNet`;
 * this carries only values that cannot be expressed as data. Declared here (not
 * in `team-runtime.ts`) so the pattern layer does not have to import back up
 * into the runtime module.
 */
export interface TeamContractNetRuntimeOptions {
  /**
   * Bid-ranking strategy handed to `ContractNetManager`. Omit to use the
   * manager's default weighted strategy. Not a policy field because it is an
   * object with behaviour, not a value.
   */
  strategy?: BidEvaluationStrategy;
}

/**
 * Execution context handed to a `TeamPattern` for one `execute` /
 * `resume` call. The runtime constructs this on every invocation.
 */
export interface TeamPatternContext {
  /** The user-supplied task prompt. */
  task: string;
  /** ID of the team definition this run is targeting. */
  teamId: string;
  /** Stable run ID for this invocation. */
  runId: string;
  /** Wall-clock ms when the run started (for duration math). */
  startedAt: number;
  /** Original team definition (read-only — patterns must not mutate). */
  definition: TeamDefinition;
  /** Effective policies for this run. */
  policies: TeamPolicies;
  /** Resolved participants whose circuit is currently closed. */
  participants: ResolvedParticipant[];
  /** Shared, in-memory blackboard — created per-run. */
  workspace: SharedWorkspace;
  /** Per-run keyed circuit breaker shared with the runtime. */
  circuitBreaker: KeyedCircuitBreaker;
  /** Optional OTel span; patterns may add events to it. */
  otelSpan: TeamOTelSpanLike | undefined;
  /**
   * Caller-supplied cancellation signal for the whole run, forwarded from
   * `TeamRuntimeOptions.signal`.
   *
   * This is runtime plumbing, NOT a `TeamPolicies` knob — an `AbortSignal` is a
   * live object, not a declarative/JSON-expressible policy value, which is why
   * it rides on the runtime options the same way it does on
   * `SupervisorConfig` / `DelegatingSupervisorConfig`. Patterns that delegate to
   * a cancellable sub-protocol (contract-net) must forward it; patterns that do
   * not may ignore it. Distinct from `execution.timeoutMs`, which rejects the
   * run but cannot cancel in-flight member calls.
   */
  signal: AbortSignal | undefined;
  /**
   * Domain event bus for protocol-level events emitted from inside a pattern's
   * sub-protocol (e.g. the `contractnet:*` events, which carry OTel metric
   * mappings), forwarded from `TeamRuntimeOptions.eventBus`.
   *
   * Runtime plumbing, not policy, for the same reason as `signal`. This is
   * deliberately NOT the team's own lifecycle emitter: team phase / participant
   * events continue to flow through `hooks` + `TeamRuntimeEventEmitter`.
   */
  eventBus: DzupEventBus | undefined;
  /**
   * Non-serializable contract-net knobs (currently the bid-ranking `strategy`),
   * forwarded from `TeamRuntimeOptions.contractNet`. Only the `contract_net`
   * pattern reads this; declarative contract-net configuration lives on
   * `policies.contractNet` instead.
   */
  contractNet: TeamContractNetRuntimeOptions | undefined;
  /** Lifecycle hooks the pattern uses to fan events back to the runtime. */
  hooks: TeamPatternHooks;
}

/** Result returned by a pattern's `execute` / `resume`. */
export type TeamPatternResult = TeamRunResult;

/**
 * Concrete agent-side specialisation of `BaseTeamCoordinationContract`.
 *
 * Every pattern under `./patterns/` exports an instance of this interface;
 * the runtime keeps a registry mapping `CoordinatorPattern → TeamPattern`.
 */
export type TeamPattern = BaseTeamCoordinationContract<
  CoordinatorPattern,
  TeamPatternContext,
  TeamPatternResult,
  TeamCheckpoint
>;
