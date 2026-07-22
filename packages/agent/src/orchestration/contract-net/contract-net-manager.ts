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
import { createWeightedStrategy } from "./bid-strategies.js";
import type {
  ContractNetConfig,
  ContractResult,
  ContractBid,
  CallForProposals,
  ContractNetState,
} from "./contract-net-types.js";
import { omitUndefined } from "../../utils/exact-optional.js";

const DEFAULT_BID_DEADLINE_MS = 30_000;
const REMOVED_MANAGER_FIELD_MESSAGE =
  "ContractNetConfig.manager was removed because ContractNetManager does not use a manager agent; omit manager and configure specialists, task, and strategy instead.";

/** Generate a unique CFP identifier. */
function generateCfpId(): string {
  return `cfp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Emit a custom contract-net event via the event bus (fire-and-forget). */
function emitContractEvent(
  eventBus: DzupEventBus | undefined,
  type: string,
  payload: Record<string, unknown>
): void {
  if (!eventBus) return;
  // TODO(DZUPAGENT-AGENT-INFO-02): When a domain-specific `contractnet:*` event type
  // is added to DzupEvent (e.g. `contractnet:cfp_broadcast`, `contractnet:awarded`,
  // `contractnet:rejected`), replace this `protocol:message_sent` emit with the
  // appropriate typed event. The generic protocol event works for now but conflates
  // contract-net lifecycle events with unrelated protocol traffic seen by otel/metrics.
  // Use onAny-compatible custom events by casting to DzupEvent.
  // The task spec says NOT to modify core DzupEvent types, so we
  // emit via the protocol event type which accepts arbitrary string data.
  eventBus.emit({
    type: "protocol:message_sent",
    protocol: "contract-net",
    to: "broadcast",
    messageType: type,
    payload,
  });
}

/**
 * Parse a bid from an agent's text response.
 * Expects JSON with the bid fields.
 */
function parseBid(
  agentId: string,
  cfpId: string,
  response: string
): ContractBid | null {
  try {
    // Try to extract JSON from the response (may be wrapped in markdown code block)
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1]! : response;

    const parsed = JSON.parse(jsonStr.trim()) as Record<string, unknown>;

    return {
      agentId,
      cfpId,
      estimatedCostCents: Number(parsed["estimatedCostCents"] ?? 0),
      estimatedDurationMs: Number(parsed["estimatedDurationMs"] ?? 0),
      qualityEstimate: Math.max(
        0,
        Math.min(1, Number(parsed["qualityEstimate"] ?? 0.5))
      ),
      confidence: Math.max(0, Math.min(1, Number(parsed["confidence"] ?? 0.5))),
      approach: String(parsed["approach"] ?? "No approach specified"),
    };
  } catch {
    return null;
  }
}

/**
 * Collect a bid from a single specialist with deadline enforcement.
 */
async function collectBid(
  specialist: DzupAgent,
  cfp: CallForProposals,
  signal: AbortSignal | undefined
): Promise<ContractBid | null> {
  const bidPrompt = [
    `You are being asked to bid on a task. Respond ONLY with a JSON object (no markdown, no explanation) containing your bid:`,
    "",
    `Task: ${cfp.task}`,
    cfp.requiredCapabilities?.length
      ? `Required capabilities: ${cfp.requiredCapabilities.join(", ")}`
      : "",
    cfp.maxCostCents != null ? `Maximum budget: ${cfp.maxCostCents} cents` : "",
    "",
    "Respond with this exact JSON structure:",
    "{",
    '  "estimatedCostCents": <number>,',
    '  "estimatedDurationMs": <number>,',
    '  "qualityEstimate": <number between 0 and 1>,',
    '  "confidence": <number between 0 and 1>,',
    '  "approach": "<brief description of your approach>"',
    "}",
  ]
    .filter(Boolean)
    .join("\n");

  // Create a deadline-scoped abort controller
  const deadlineController = new AbortController();
  const timer = setTimeout(() => deadlineController.abort(), cfp.bidDeadlineMs);

  // If external signal is already aborted, abort immediately
  const onExternalAbort = (): void => deadlineController.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    // Race the generate call against the deadline to enforce hard timeout.
    // model.invoke() may not respect AbortSignal internally, so we need
    // an explicit race to guarantee deadline enforcement.
    const deadlinePromise = new Promise<null>((resolve) => {
      const onAbort = (): void => resolve(null);
      if (deadlineController.signal.aborted) {
        resolve(null);
        return;
      }
      deadlineController.signal.addEventListener("abort", onAbort, {
        once: true,
      });
    });

    const generatePromise = specialist
      .generate([new HumanMessage(bidPrompt)], {
        signal: deadlineController.signal,
      })
      .then((result) => parseBid(specialist.id, cfp.cfpId, result.content));

    return await Promise.race([generatePromise, deadlinePromise]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

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
    if ("manager" in config) {
      throw new OrchestrationError(
        REMOVED_MANAGER_FIELD_MESSAGE,
        "contract-net"
      );
    }

    const { task, signal, eventBus } = config;
    const { state, cfp } = ContractNetManager.initState(config);
    const cfpId = cfp.cfpId;

    // Check abort before starting
    if (signal?.aborted) {
      throw new OrchestrationError(
        "contract-net aborted before execution",
        "contract-net",
        { cfpId }
      );
    }

    // Phase 1 + 2: Announce and collect bids (with optional retry-on-no-bids).
    await ContractNetManager.runBiddingPhase(state, config);

    // Phase 3 + 4: Evaluate, award, and resolve the winning specialist agent.
    const { winningBid, winner } = ContractNetManager.selectWinner(
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
    return ContractNetManager.runExecutionPhase({
      state,
      winner,
      winningBid,
      task,
      signal,
      eventBus,
    });
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
    config: ContractNetConfig
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
    emitContractEvent(eventBus, "contract-net:cfp_announced", { cfpId, task });

    // Phase 2: Collect bids
    state.phase = "bidding";
    const bids = await ContractNetManager.collectBids(specialists, cfp, signal);
    ContractNetManager.recordBids(state, bids, eventBus);

    if (bids.length > 0) return;

    if (!retryOnNoBids) {
      state.phase = "failed";
      emitContractEvent(eventBus, "contract-net:failed", {
        cfpId,
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
      signal
    );
    ContractNetManager.recordBids(state, retryBids, eventBus);

    if (retryBids.length === 0) {
      state.phase = "failed";
      emitContractEvent(eventBus, "contract-net:failed", {
        cfpId,
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
      emitContractEvent(eventBus, "contract-net:bid_received", {
        cfpId: state.cfp.cfpId,
        agentId: bid.agentId,
      });
    }
  }

  /**
   * Phases 3–4: evaluate/rank the collected bids, award to the top bid, and
   * resolve the winning specialist agent. Mutates `state` and throws
   * {@link OrchestrationError} when no winner can be determined.
   */
  private static selectWinner(
    state: ContractNetState,
    config: ContractNetConfig
  ): { winningBid: ContractBid; winner: DzupAgent } {
    const { specialists, eventBus } = config;
    const strategy = config.strategy ?? createWeightedStrategy({});
    const cfpId = state.cfp.cfpId;

    // Phase 3: Evaluate
    state.phase = "evaluating";
    const rankedBids = strategy.evaluate(state.bids);
    const winningBid = rankedBids[0];

    if (!winningBid) {
      state.phase = "failed";
      throw new OrchestrationError(
        "Bid evaluation returned no results",
        "contract-net",
        { cfpId }
      );
    }

    // Phase 4: Award
    state.phase = "awarding";
    state.award = {
      cfpId,
      winnerId: winningBid.agentId,
      bid: winningBid,
    };
    emitContractEvent(eventBus, "contract-net:awarded", {
      cfpId,
      winnerId: winningBid.agentId,
    });

    const winner = specialists.find((s) => s.id === winningBid.agentId);
    if (!winner) {
      state.phase = "failed";
      throw new OrchestrationError(
        `Winning agent "${winningBid.agentId}" not found in specialists`,
        "contract-net",
        { cfpId }
      );
    }

    return { winningBid, winner };
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
  }): Promise<ContractResult> {
    const { state, winner, winningBid, task, signal, eventBus } = args;
    const cfpId = state.cfp.cfpId;

    state.phase = "executing";
    const startTime = Date.now();

    try {
      const execResult = await winner.generate(
        [
          new HumanMessage(
            `Execute this task using your proposed approach:\n\nTask: ${task}\n\nYour approach: ${winningBid.approach}`
          ),
        ],
        omitUndefined({ signal })
      );

      const durationMs = Date.now() - startTime;

      state.phase = "completed";
      const contractResult: ContractResult = {
        cfpId,
        agentId: winningBid.agentId,
        success: true,
        result: execResult.content,
        actualDurationMs: durationMs,
      };
      state.result = contractResult;

      emitContractEvent(eventBus, "contract-net:completed", {
        cfpId,
        agentId: winningBid.agentId,
        durationMs,
      });

      return contractResult;
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      state.phase = "failed";
      const contractResult: ContractResult = {
        cfpId,
        agentId: winningBid.agentId,
        success: false,
        error: errorMessage,
        actualDurationMs: durationMs,
      };
      state.result = contractResult;

      emitContractEvent(eventBus, "contract-net:failed", {
        cfpId,
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
    signal: AbortSignal | undefined
  ): Promise<ContractBid[]> {
    const bidPromises = specialists.map((specialist) =>
      collectBid(specialist, cfp, signal)
    );

    const results = await Promise.all(bidPromises);
    return results.filter((bid): bid is ContractBid => bid !== null);
  }
}
