/**
 * ContractNetManager — executes the full contract-net protocol lifecycle.
 *
 * 1. Announce CFP (Call For Proposals)
 * 2. Collect bids from specialists (with deadline enforcement)
 * 3. Evaluate bids using pluggable strategy
 * 4. Award contract to best bidder
 * 5. Execute task with winning specialist
 * 6. Return result
 */
import { HumanMessage } from "@langchain/core/messages";
import type { DzupAgent } from "../../agent/dzip-agent.js";
import type { DzupEventBus } from "@dzupagent/core/events";
import { OrchestrationError } from "../orchestration-error.js";
import {
  DEFAULT_ORCHESTRATION_FANOUT,
  runAllConcurrently,
} from "../concurrency-runner.js";
import {
  DEFAULT_BID_DEADLINE_MS,
  REMOVED_MANAGER_FIELD_MESSAGE,
  collectBid,
  completeInvocation,
  elapsedSince,
  emitContractEvent,
  generateCfpId,
  normalizeInvocationError,
  startInvocation,
  type ContractNetInvocationState,
} from "./contract-net-bidding.js";
import { selectWinner } from "./contract-net-selection.js";
import type {
  ContractNetConfig,
  ContractResult,
  ContractBid,
  CallForProposals,
  ContractNetState,
  ContractNetDetailedResult,
} from "./contract-net-types.js";
import { omitUndefined } from "../../utils/exact-optional.js";


export class ContractNetManager {
  /**
   * Execute the full contract-net protocol lifecycle.
   *
   * This is a thin orchestrator over cohesive phase helpers:
   *  - {@link initState}      — validate config, build CFP + initial state.
   *  - {@link runBiddingPhase} — announce, collect bids (with optional retry).
  *  - {@link selectWinner}   — evaluate/rank bids, award, resolve winner agent.
  *  - {@link runExecutionPhase} — run the winning specialist, assemble result.
  */
  static async execute(config: ContractNetConfig): Promise<ContractResult> {
    return (await ContractNetManager.executeDetailed(config)).result;
  }

  /** Execute once and retain ordered evidence for every settled model call. */
  static async executeDetailed(
    config: ContractNetConfig
  ): Promise<ContractNetDetailedResult> {
    if ("manager" in config) {
      throw new OrchestrationError(
        REMOVED_MANAGER_FIELD_MESSAGE,
        "contract-net"
      );
    }

    const { task, signal, eventBus } = config;
    const { state, cfp } = ContractNetManager.initState(config);
    const cfpId = cfp.cfpId;
    const invocationState: ContractNetInvocationState = {
      nextInvocationIndex: 0,
      invocations: [],
      observer: config.invocationObserver,
    };

    // Check abort before starting
    if (signal?.aborted) {
      throw new OrchestrationError(
        "contract-net aborted before execution",
        "contract-net",
        { cfpId }
      );
    }

    // Phase 1 + 2: Announce and collect bids (with optional retry-on-no-bids).
    await ContractNetManager.runBiddingPhase(state, config, invocationState);

    // Phase 3 + 4: Evaluate, award, and resolve the winning specialist agent.
    const { winningBid, winner } = selectWinner(
      state,
      config
    );

    // Check abort before execution
    if (signal?.aborted) {
      throw new OrchestrationError(
        "contract-net aborted before execution phase",
        "contract-net",
        { cfpId, winnerId: winningBid.agentId }
      );
    }

    // Phase 5: Execute the task with the winning specialist.
    const result = await ContractNetManager.runExecutionPhase({
      state,
      winner,
      winningBid,
      task,
      signal,
      eventBus,
      invocationState,
    });
    return {
      result,
      invocations: [...invocationState.invocations].sort(
        (left, right) => left.invocationIndex - right.invocationIndex
      ),
    };
  }

  /**
   * Validate config, resolve defaults, and build the CFP + initial state.
   * Pure setup — performs no I/O and emits no events.
   */
  private static initState(config: ContractNetConfig): {
    state: ContractNetState;
    cfp: CallForProposals;
  } {
    const { task, maxCostCents, requiredCapabilities } = config;
    const bidDeadlineMs = config.bidDeadlineMs ?? DEFAULT_BID_DEADLINE_MS;
    const cfpId = generateCfpId();

    const cfp: CallForProposals = omitUndefined({
      cfpId,
      task,
      requiredCapabilities,
      maxCostCents,
      bidDeadlineMs,
    });

    const state: ContractNetState = {
      phase: "announcing",
      cfp,
      bids: [],
    };

    return { state, cfp };
  }

  /**
   * Phases 1–2: announce the CFP, collect bids, and (when configured) retry
   * once with an extended deadline. Mutates `state.phase`/`state.bids` and
   * throws {@link OrchestrationError} when no bids can be obtained.
   */
  private static async runBiddingPhase(
    state: ContractNetState,
    config: ContractNetConfig,
    invocationState: ContractNetInvocationState
  ): Promise<void> {
    const {
      specialists,
      task,
      signal,
      eventBus,
      retryOnNoBids = false,
    } = config;
    const cfp = state.cfp;
    const cfpId = cfp.cfpId;

    // Phase 1: Announce
    emitContractEvent(eventBus, { type: "contractnet:announced", cfpId, task });

    // Phase 2: Collect bids
    state.phase = "bidding";
    const bids = await ContractNetManager.collectBids(
      specialists,
      cfp,
      signal,
      invocationState,
      0
    );
    ContractNetManager.recordBids(state, bids, eventBus);

    if (bids.length > 0) return;

    if (!retryOnNoBids) {
      state.phase = "failed";
      emitContractEvent(eventBus, {
        type: "contractnet:failed",
        cfpId,
        phase: "bidding",
        reason: "No bids received",
      });
      throw new OrchestrationError("No bids received", "contract-net", {
        cfpId,
      });
    }

    // Retry once with extended deadline
    const retryBids = await ContractNetManager.collectBids(
      specialists,
      { ...cfp, bidDeadlineMs: cfp.bidDeadlineMs * 2 },
      signal,
      invocationState,
      1
    );
    ContractNetManager.recordBids(state, retryBids, eventBus);

    if (retryBids.length === 0) {
      state.phase = "failed";
      emitContractEvent(eventBus, {
        type: "contractnet:failed",
        cfpId,
        phase: "bidding",
        reason: "No bids received after retry",
      });
      throw new OrchestrationError(
        "No bids received after retry",
        "contract-net",
        { cfpId }
      );
    }
  }

  /** Append bids to state and emit a `bid_received` event for each. */
  private static recordBids(
    state: ContractNetState,
    bids: ContractBid[],
    eventBus: DzupEventBus | undefined
  ): void {
    for (const bid of bids) {
      state.bids.push(bid);
      emitContractEvent(eventBus, {
        type: "contractnet:bid_received",
        cfpId: state.cfp.cfpId,
        agentId: bid.agentId,
      });
    }
  }

  /**
   * Phase 5: run the task with the winning specialist and assemble the
   * {@link ContractResult}. Errors from the specialist are captured into a
   * failed (but returned) result rather than thrown.
   */
  private static async runExecutionPhase(args: {
    state: ContractNetState;
    winner: DzupAgent;
    winningBid: ContractBid;
    task: string;
    signal: AbortSignal | undefined;
    eventBus: DzupEventBus | undefined;
    invocationState: ContractNetInvocationState;
  }): Promise<ContractResult> {
    const {
      state,
      winner,
      winningBid,
      task,
      signal,
      eventBus,
      invocationState,
    } = args;
    const cfpId = state.cfp.cfpId;

    state.phase = "executing";
    const start = startInvocation(
      invocationState,
      winningBid.agentId,
      "execute"
    );
    const startedAt = Date.now();

    try {
      const execResult = await winner.generate(
        [
          new HumanMessage(
            `Execute this task using your proposed approach:\n\nTask: ${task}\n\nYour approach: ${winningBid.approach}`
          ),
        ],
        omitUndefined({ signal })
      );

      const durationMs = elapsedSince(startedAt);
      completeInvocation(invocationState, {
        ...start,
        success: true,
        durationMs,
        content: execResult.content,
      });

      state.phase = "completed";
      const contractResult: ContractResult = {
        cfpId,
        agentId: winningBid.agentId,
        success: true,
        result: execResult.content,
        actualDurationMs: durationMs,
      };
      state.result = contractResult;

      emitContractEvent(eventBus, {
        type: "contractnet:completed",
        cfpId,
        agentId: winningBid.agentId,
        durationMs,
      });

      return contractResult;
    } catch (err: unknown) {
      const durationMs = elapsedSince(startedAt);
      const cancelled = signal?.aborted === true;
      const errorMessage = cancelled
        ? "Execution cancelled"
        : normalizeInvocationError(err);
      completeInvocation(invocationState, {
        ...start,
        success: false,
        durationMs,
        failureKind: cancelled ? "cancelled" : "model_error",
        error: errorMessage,
      });

      state.phase = "failed";
      const contractResult: ContractResult = {
        cfpId,
        agentId: winningBid.agentId,
        success: false,
        error: errorMessage,
        actualDurationMs: durationMs,
      };
      state.result = contractResult;

      emitContractEvent(eventBus, {
        type: "contractnet:failed",
        cfpId,
        phase: "executing",
        agentId: winningBid.agentId,
        error: errorMessage,
      });

      return contractResult;
    }
  }

  /**
   * Collect bids from all specialists in parallel.
   */
  private static async collectBids(
    specialists: DzupAgent[],
    cfp: CallForProposals,
    signal: AbortSignal | undefined,
    invocationState: ContractNetInvocationState,
    attempt: number,
    maxConcurrency: number = DEFAULT_ORCHESTRATION_FANOUT
  ): Promise<ContractBid[]> {
    // ORCH-DSL-L1-H-07 — bounded fan-out. One model call per specialist was
    // previously dispatched simultaneously with no cap. `collectBid` already
    // absorbs its own failures and returns null, so `runAllConcurrently`
    // preserves the previous semantics exactly while capping in-flight calls.
    const results = await runAllConcurrently(
      specialists.map(
        (specialist) => (taskSignal?: AbortSignal) =>
          collectBid(
            specialist,
            cfp,
            taskSignal ?? signal,
            invocationState,
            attempt
          )
      ),
      maxConcurrency,
      signal ? { signal } : undefined
    );
    return results.filter((bid): bid is ContractBid => bid !== null);
  }
}
