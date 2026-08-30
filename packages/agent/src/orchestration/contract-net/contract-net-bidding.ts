/**
 * Bid collection for the contract-net protocol.
 *
 * Owns everything between announcing a CFP and having a list of parsed bids:
 * the per-run invocation ledger the observer is fed from, the untrusted-output
 * bid parser, and the deadline/cancellation-scoped single-specialist bid call.
 * `contract-net-manager.ts` keeps the phase orchestration and consumes this
 * module's exports.
 *
 * @module orchestration/contract-net/contract-net-bidding
 */
import { HumanMessage } from "@langchain/core/messages";
import type { DzupAgent } from "../../agent/dzip-agent.js";
import type { DzupEvent, DzupEventBus } from "@dzupagent/core/events";
import { typedEmit } from "@dzupagent/core/events";
import type {
  ContractBid,
  CallForProposals,
  ContractNetInvocationFailureKind,
  ContractNetInvocationObserver,
  ContractNetInvocationOutcome,
  ContractNetInvocationPhase,
  ContractNetInvocationStart,
} from "./contract-net-types.js";
import { omitUndefined } from "../../utils/exact-optional.js";

export const DEFAULT_BID_DEADLINE_MS = 30_000;
export const REMOVED_MANAGER_FIELD_MESSAGE =
  "ContractNetConfig.manager was removed because ContractNetManager does not use a manager agent; omit manager and configure specialists, task, and strategy instead.";
const INVALID_BID_ERROR = "Invalid bid response";
const BID_DEADLINE_ERROR = "Bid deadline exceeded";
const BID_CANCELLED_ERROR = "Bid cancelled";

export interface ContractNetInvocationState {
  nextInvocationIndex: number;
  invocations: ContractNetInvocationOutcome[];
  observer: ContractNetInvocationObserver | undefined;
}

/** Generate a unique CFP identifier. */
export function generateCfpId(): string {
  return `cfp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function elapsedSince(startedAt: number): number {
  const duration = Date.now() - startedAt;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export function normalizeInvocationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifyInvocationObserver<T>(
  callback: ((value: T) => unknown) | undefined,
  value: T
): void {
  if (!callback) return;
  try {
    const result = callback(value);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result
    ) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Contract-net observation is evidence-only and cannot alter execution.
  }
}

export function startInvocation(
  state: ContractNetInvocationState,
  agentId: string,
  phase: ContractNetInvocationPhase,
  attempt?: number
): ContractNetInvocationStart {
  const start: ContractNetInvocationStart = omitUndefined({
    agentId,
    phase,
    invocationIndex: state.nextInvocationIndex++,
    attempt,
  });
  notifyInvocationObserver(state.observer?.onStart, start);
  return start;
}

export function completeInvocation(
  state: ContractNetInvocationState,
  outcome: ContractNetInvocationOutcome
): void {
  state.invocations.push(outcome);
  notifyInvocationObserver(state.observer?.onComplete, outcome);
}

/**
 * Emit a typed `contractnet:*` lifecycle event via the event bus
 * (fire-and-forget; a missing bus is a no-op).
 *
 * These discriminated-union events (see `OrchestrationDomainEvent` in
 * @dzupagent/core) replace the earlier `protocol:message_sent` conflation
 * (DZUPAGENT-AGENT-INFO-02) so otel/metrics observe contract-net phases
 * directly instead of decoding an opaque `messageType` string.
 */
export function emitContractEvent(
  eventBus: DzupEventBus | undefined,
  event: Extract<DzupEvent, { type: `contractnet:${string}` }>
): void {
  typedEmit(eventBus, event);
}

/**
 * Normalise the self-reported `capabilities` field of a bid.
 *
 * This is untrusted model output, so anything that is not an array of usable
 * strings degrades to `undefined` ("did not answer") rather than to `[]`
 * ("declared none"). Both are unqualified under a non-empty requirement, but
 * only `undefined` is honest about a bidder that never addressed the question.
 *
 * Entries are trimmed and blanks dropped, because a stray `" "` is not a
 * capability. Non-string entries are dropped rather than coerced: `String(0)`
 * would mint the capability `"0"`, which could match a requirement literally
 * nobody intended.
 */
function parseCapabilities(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tags = raw
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return tags.length > 0 ? tags : undefined;
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

    return omitUndefined({
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
      capabilities: parseCapabilities(parsed["capabilities"]),
    });
  } catch {
    return null;
  }
}

/**
 * Collect a bid from a single specialist with deadline enforcement.
 */
export async function collectBid(
  specialist: DzupAgent,
  cfp: CallForProposals,
  signal: AbortSignal | undefined,
  invocationState: ContractNetInvocationState,
  attempt: number
): Promise<ContractBid | null> {
  const bidPrompt = [
    `You are being asked to bid on a task. Respond ONLY with a JSON object (no markdown, no explanation) containing your bid:`,
    "",
    `Task: ${cfp.task}`,
    cfp.requiredCapabilities?.length
      ? `Required capabilities: ${cfp.requiredCapabilities.join(", ")}`
      : "",
    // Only demanded when it is enforced. Asking unconditionally would train
    // bidders to emit a field that nothing reads on most CFPs.
    cfp.requiredCapabilities?.length
      ? `You must list which of these you actually have in "capabilities". Claim ONLY capabilities you genuinely have: a bid missing any required capability is discarded before ranking and cannot win.`
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
    ...(cfp.requiredCapabilities?.length
      ? ['  , "capabilities": ["<capability>", ...]']
      : []),
    "}",
  ]
    .filter(Boolean)
    .join("\n");

  // Queued bounded work cancelled before it starts has no invocation evidence.
  if (signal?.aborted) return null;

  // Create a deadline-scoped abort controller.
  const deadlineController = new AbortController();
  let abortKind: Extract<
    ContractNetInvocationFailureKind,
    "deadline" | "cancelled"
  > = "deadline";
  const timer = setTimeout(() => {
    if (deadlineController.signal.aborted) return;
    abortKind = "deadline";
    deadlineController.abort();
  }, cfp.bidDeadlineMs);

  const onExternalAbort = (): void => {
    if (deadlineController.signal.aborted) return;
    abortKind = "cancelled";
    deadlineController.abort(signal?.reason);
  };
  if (signal?.aborted) onExternalAbort();
  else signal?.addEventListener("abort", onExternalAbort, { once: true });

  if (deadlineController.signal.aborted) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    return null;
  }

  const start = startInvocation(
    invocationState,
    specialist.id,
    "bid",
    attempt
  );
  const startedAt = Date.now();

  try {
    type BidTerminal =
      | { type: "generated"; content: string }
      | { type: "model_error"; error: unknown }
      | {
          type: "aborted";
          failureKind: Extract<
            ContractNetInvocationFailureKind,
            "deadline" | "cancelled"
          >;
        };

    // The explicit abort branch terminalizes a deadline even when a provider
    // ignores AbortSignal. The generated promise handles its own later reject,
    // so a post-deadline settlement cannot emit a second outcome.
    const abortPromise = new Promise<BidTerminal>((resolve) => {
      const onAbort = (): void =>
        resolve({ type: "aborted", failureKind: abortKind });
      if (deadlineController.signal.aborted) {
        onAbort();
        return;
      }
      deadlineController.signal.addEventListener("abort", onAbort, {
        once: true,
      });
    });

    const generatePromise: Promise<BidTerminal> = specialist
      .generate([new HumanMessage(bidPrompt)], {
        signal: deadlineController.signal,
      })
      .then(
        (result) => ({ type: "generated", content: result.content }),
        (error: unknown) => ({ type: "model_error", error })
      );

    const terminal = await Promise.race([generatePromise, abortPromise]);
    const durationMs = elapsedSince(startedAt);

    if (terminal.type === "generated") {
      const parsed = parseBid(specialist.id, cfp.cfpId, terminal.content);
      if (parsed) {
        completeInvocation(invocationState, {
          ...start,
          success: true,
          durationMs,
          content: terminal.content,
        });
        return parsed;
      }
      completeInvocation(invocationState, {
        ...start,
        success: false,
        durationMs,
        failureKind: "invalid_bid",
        error: INVALID_BID_ERROR,
      });
      return null;
    }

    const failureKind: ContractNetInvocationFailureKind =
      terminal.type === "aborted"
        ? terminal.failureKind
        : deadlineController.signal.aborted
          ? abortKind
          : "model_error";
    const error =
      failureKind === "deadline"
        ? BID_DEADLINE_ERROR
        : failureKind === "cancelled"
          ? BID_CANCELLED_ERROR
          : terminal.type === "model_error"
            ? normalizeInvocationError(terminal.error)
            : BID_CANCELLED_ERROR;
    completeInvocation(invocationState, {
      ...start,
      success: false,
      durationMs,
      failureKind,
      error,
    });
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}
