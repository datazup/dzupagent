/**
 * Multi-agent orchestration patterns.
 *
 * Provides composable patterns for coordinating multiple DzupAgent instances:
 * - Sequential: A -> B -> C (pipeline)
 * - Parallel: A, B, C concurrently, results merged
 * - Supervisor: Manager delegates to specialists via tool calling
 *   (implementation lives in {@link ./supervisor-runner.ts})
 * - Debate: Multiple proposers, judge selects best
 * - Contract-net: Manager announces task, specialists bid, best bidder
 *   executes (delegated to {@link ./contract-net/contract-net-manager.ts})
 *
 * Type definitions for the supervisor surface live in
 * {@link ./supervisor-types.ts} and are re-exported here for backwards
 * compatibility.
 */
import { HumanMessage } from "@langchain/core/messages";
import { DzupAgent } from "../agent/dzip-agent.js";
import { OrchestrationError } from "./orchestration-error.js";
import { ContractNetManager } from "./contract-net/contract-net-manager.js";
import type {
  ContractNetConfig,
  ContractResult,
} from "./contract-net/contract-net-types.js";
import type { AgentCircuitBreaker } from "./circuit-breaker.js";
import type { OrchestrationMergeStrategy } from "./orchestration-merge-strategy-types.js";
import {
  recordParallelCircuitBreakerOutcomes,
  renderMergedParallelOutput,
  toParallelAgentResults,
} from "./parallel-orchestration-results.js";
import {
  DEFAULT_ORCHESTRATION_FANOUT,
  runAllConcurrently,
  runConcurrently,
} from "./concurrency-runner.js";
import { clearSupervisorCache, runSupervisor } from "./supervisor-runner.js";
import type {
  DebateInvocationObserver,
  DebateInvocationOutcome,
  DebateInvocationStart,
  DebateOptions,
  DebateParticipantRole,
  DebateResult,
} from "./debate-types.js";
import type {
  MergeFn,
  SupervisorConfig,
  SupervisorResult,
} from "./supervisor-types.js";

export type {
  MergeFn,
  SupervisorConfig,
  SupervisorResult,
} from "./supervisor-types.js";
export type {
  DebateInvocationObserver,
  DebateInvocationOutcome,
  DebateInvocationStart,
  DebateOptions,
  DebateParticipantRole,
  DebateResult,
} from "./debate-types.js";

const defaultMerge: MergeFn = (results) =>
  results.map((r, i) => `--- Agent ${i + 1} ---\n${r}`).join("\n\n");

interface DebateInvocationState {
  nextInvocationIndex: number;
  readonly invocations: DebateInvocationOutcome[];
  readonly observer: DebateInvocationObserver | undefined;
}

interface DebateAgentInvocation {
  readonly role: DebateParticipantRole;
  readonly round?: number;
  readonly signal?: AbortSignal;
}

async function invokeDebateAgent(
  agent: DzupAgent,
  input: string,
  state: DebateInvocationState,
  invocation: DebateAgentInvocation
): Promise<string> {
  const messages = [new HumanMessage(input)];
  const invocationIndex = state.nextInvocationIndex++;
  const start: DebateInvocationStart =
    invocation.round === undefined
      ? {
          agentId: agent.id,
          role: invocation.role,
          invocationIndex,
        }
      : {
          agentId: agent.id,
          role: invocation.role,
          invocationIndex,
          round: invocation.round,
        };
  notifyDebateObserver(state.observer?.onStart, start);
  const startedAt = Date.now();

  try {
    const result = await agent.generate(
      messages,
      invocation.signal ? { signal: invocation.signal } : undefined
    );
    const outcome: DebateInvocationOutcome = {
      ...start,
      success: true,
      durationMs: elapsedSince(startedAt),
      content: result.content,
    };
    state.invocations.push(outcome);
    notifyDebateObserver(state.observer?.onComplete, outcome);
    return result.content;
  } catch (error: unknown) {
    const outcome: DebateInvocationOutcome = {
      ...start,
      success: false,
      durationMs: elapsedSince(startedAt),
      error: normalizeDebateError(error),
    };
    state.invocations.push(outcome);
    notifyDebateObserver(state.observer?.onComplete, outcome);
    throw error;
  }
}

function elapsedSince(startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function normalizeDebateError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifyDebateObserver<T>(
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
    // Debate observation is evidence-only and must never alter execution.
  }
}

export class AgentOrchestrator {
  /**
   * Clear the supervisor agent cache. Use when the lifecycle owner of
   * AgentOrchestrator is being torn down or when underlying agent
   * configuration is known to have changed.
   */
  static clearSupervisorCache(): void {
    clearSupervisorCache();
  }

  /**
   * Run agents sequentially -- each receives the previous agent's output.
   */
  static async sequential(
    agents: DzupAgent[],
    initialInput: string
  ): Promise<string> {
    let current = initialInput;
    for (const agent of agents) {
      const result = await agent.generate([new HumanMessage(current)]);
      current = result.content;
    }
    return current;
  }

  /**
   * Run agents in parallel -- all receive the same input, results merged.
   *
   * When `options.circuitBreaker` is provided, agents with tripped circuits
   * are excluded and success/timeout is recorded after each agent completes.
   * When `options.mergeStrategy` is provided, it is used instead of the
   * legacy `merge` function for combining results.
   */
  static async parallel(
    agents: DzupAgent[],
    input: string,
    merge?: MergeFn,
    options?: {
      circuitBreaker?: AgentCircuitBreaker;
      mergeStrategy?: OrchestrationMergeStrategy<string>;
      /**
       * Maximum number of agents to run concurrently.
       * When set, agents run in batches rather than all at once, preventing
       * resource exhaustion with large agent lists.
       * Default: unlimited.
       */
      maxConcurrency?: number;
      /**
       * Cancellation signal. When it aborts, in-flight agent generations are
       * cancelled. In the default (reject-on-first-failure) path, a failure in
       * any agent also cancels the remaining in-flight siblings.
       */
      signal?: AbortSignal;
    }
  ): Promise<string> {
    let effectiveAgents = agents;

    // Filter through circuit breaker if configured
    if (options?.circuitBreaker) {
      effectiveAgents = options.circuitBreaker.filterAvailable(agents);
      if (effectiveAgents.length === 0) {
        throw new OrchestrationError(
          "All agents filtered by circuit breaker in parallel execution",
          "parallel"
        );
      }
    }

    // When merge strategy or circuit breaker is active, use allSettled for resilience
    if (options?.mergeStrategy || options?.circuitBreaker) {
      const settled = await runConcurrently(
        effectiveAgents.map(
          (agent) => (signal?: AbortSignal) =>
            agent.generate(
              [new HumanMessage(input)],
              signal ? { signal } : undefined
            )
        ),
        options?.maxConcurrency,
        options?.signal ? { signal: options.signal } : undefined
      );

      recordParallelCircuitBreakerOutcomes(
        effectiveAgents,
        settled,
        options.circuitBreaker
      );

      // Use OrchestrationMergeStrategy if provided
      if (options.mergeStrategy) {
        const agentResults = toParallelAgentResults(effectiveAgents, settled);
        const merged = options.mergeStrategy.merge(agentResults);
        return renderMergedParallelOutput(merged);
      }

      // Fallback: collect fulfilled results for legacy merge
      const contents: string[] = [];
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          contents.push(outcome.value.content);
        }
      }
      return (merge ?? defaultMerge)(contents);
    }

    // Default path: reject on first failure; respect maxConcurrency.
    // On first failure (or external abort), in-flight siblings are cancelled.
    const results = await runAllConcurrently(
      effectiveAgents.map(
        (agent) => (signal?: AbortSignal) =>
          agent.generate(
            [new HumanMessage(input)],
            signal ? { signal } : undefined
          )
      ),
      options?.maxConcurrency,
      options?.signal ? { signal: options.signal } : undefined
    );
    const contents = results.map((r) => r.content);
    return (merge ?? defaultMerge)(contents);
  }

  /**
   * Supervisor pattern -- manager agent delegates to specialist agents via tools.
   *
   * Each specialist is converted to a LangChain tool via `asTool()` and injected
   * into a new manager agent instance. The manager LLM then invokes specialists
   * through standard function calling. Results flow back as ToolMessages.
   */
  static async supervisor(config: SupervisorConfig): Promise<SupervisorResult>;
  /** @deprecated Use the config object overload instead */
  static async supervisor(
    manager: DzupAgent,
    specialists: DzupAgent[],
    task: string
  ): Promise<string>;
  static async supervisor(
    configOrManager: SupervisorConfig | DzupAgent,
    maybeSpecialists?: DzupAgent[],
    maybeTask?: string
  ): Promise<SupervisorResult | string> {
    // Normalize arguments: support both old positional and new config-object signatures
    let config: SupervisorConfig;
    let returnLegacy = false;

    if (configOrManager instanceof DzupAgent) {
      if (!maybeSpecialists || !maybeTask) {
        throw new OrchestrationError(
          "supervisor() requires specialists and task when called with positional arguments",
          "supervisor"
        );
      }
      config = {
        manager: configOrManager,
        specialists: maybeSpecialists,
        task: maybeTask,
      };
      returnLegacy = true;
    } else {
      config = configOrManager;
    }

    const result = await runSupervisor(config);
    return returnLegacy ? result.content : result;
  }

  /**
   * Debate pattern -- multiple agents propose solutions, a judge selects the best.
   *
   * Cancellation: when `options.signal` is supplied the debate fails fast if the
   * signal is already aborted, and the signal is threaded into every proposer
   * round and the final judge call so in-flight generations are cancelled
   * rather than running to completion. The positional signature is unchanged;
   * `signal` rides on the existing options bag.
   */
  static async debate(
    proposers: DzupAgent[],
    judge: DzupAgent,
    task: string,
    options?: DebateOptions
  ): Promise<string> {
    const result = await this.debateDetailed(proposers, judge, task, options);
    return result.content;
  }

  /**
   * Run a debate and return truthful evidence for every model invocation that
   * actually started and settled.
   *
   * Invocation callbacks are best-effort and receive only the minimal public
   * evidence contract. Failures still reject with the exact original value;
   * callers that need failure-path evidence can retain observer completions.
   */
  static async debateDetailed(
    proposers: DzupAgent[],
    judge: DzupAgent,
    task: string,
    options?: DebateOptions
  ): Promise<DebateResult> {
    const startedAt = Date.now();
    const rounds = options?.rounds ?? 1;
    const signal = options?.signal;
    let proposals: string[] = [];
    let roundsExecuted = 0;
    const state: DebateInvocationState = {
      nextInvocationIndex: 0,
      invocations: [],
      observer: options?.invocationObserver,
    };

    // Fail fast before spawning any proposer work, mirroring the
    // supervisor/contract-net guards.
    if (signal?.aborted) {
      throw new OrchestrationError(
        "debate() aborted before execution",
        "debate"
      );
    }

    for (let round = 0; round < rounds; round++) {
      // Each proposer generates a solution
      const roundInput =
        round === 0
          ? task
          : `${task}\n\nPrevious proposals:\n${proposals
              .map((p, i) => `Proposal ${i + 1}: ${p}`)
              .join(
                "\n\n"
              )}\n\nImprove upon the best aspects of all proposals.`;

      // ORCH-DSL-L1-H-07 — bounded fan-out. This previously issued one
      // simultaneous model call per proposer, per round, with no cap, even
      // though `parallel()` above already routes through the same pool.
      // `runAllConcurrently` is the right half of the pair here: it preserves
      // input order (the proposals below are rendered as indexed "Proposal N")
      // and rejects on first failure, matching the previous `Promise.all`
      // semantics while additionally cancelling in-flight siblings.
      const results = await runAllConcurrently(
        proposers.map(
          (agent) => (taskSignal?: AbortSignal) =>
            invokeDebateAgent(agent, roundInput, state, {
              role: "proposer",
              round,
              ...(taskSignal ? { signal: taskSignal } : {}),
            })
        ),
        options?.maxConcurrency ?? DEFAULT_ORCHESTRATION_FANOUT,
        signal ? { signal } : undefined
      );
      proposals = results;
      roundsExecuted += 1;
    }

    // Judge selects the best
    const judgeInput = proposals
      .map((p, i) => `## Proposal ${i + 1}\n${p}`)
      .join("\n\n");

    const content = await invokeDebateAgent(
      judge,
      `Evaluate these proposals for the following task:\n\n**Task:** ${task}\n\n${judgeInput}\n\n` +
        `Select the best proposal (or synthesize the best parts of multiple proposals). ` +
        `Explain your reasoning briefly, then provide the final answer.`,
      state,
      {
        role: "judge",
        ...(signal ? { signal } : {}),
      }
    );

    return {
      content,
      invocations: [...state.invocations].sort(
        (left, right) => left.invocationIndex - right.invocationIndex
      ),
      roundsExecuted,
      durationMs: elapsedSince(startedAt),
    };
  }

  /**
   * Contract-net pattern -- manager announces task, specialists bid,
   * best bidder executes.
   */
  static async contractNet(config: ContractNetConfig): Promise<ContractResult> {
    return ContractNetManager.execute(config);
  }
}
