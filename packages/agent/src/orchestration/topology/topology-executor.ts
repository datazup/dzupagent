/**
 * TopologyExecutor — executes agent communication using different topologies.
 *
 * Supports mesh (all-to-all), ring (circular pass), and delegates to
 * AgentOrchestrator for hierarchical/pipeline/star patterns.
 */
import { HumanMessage } from "@langchain/core/messages";
import { AgentOrchestrator } from "../orchestrator.js";
import type { SupervisorResult } from "../orchestrator.js";
import { OrchestrationError } from "../orchestration-error.js";
import {
  DEFAULT_ORCHESTRATION_FANOUT,
  runConcurrently,
} from "../concurrency-runner.js";
import { TopologyAnalyzer } from "./topology-analyzer.js";
import type {
  TopologyType,
  TopologyMetrics,
  TopologyExecutorConfig,
  TaskCharacteristics,
} from "./topology-types.js";
import { omitUndefined } from "../../utils/exact-optional.js";

export interface MeshResult {
  results: string[];
  metrics: TopologyMetrics;
}

/**
 * Default number of mesh rounds.
 *
 * Mesh is an all-to-all peer-exchange topology: round 0 produces initial
 * positions and every later round lets each agent revise in light of its
 * peers. A single round therefore exchanges nothing and degenerates into
 * star fan-out, so 2 is the smallest value that is actually a mesh — one
 * round to produce, one to react. Ring defaults to 3 because it refines a
 * single artifact serially; mesh multiplies calls by agent count each round,
 * so it stays deliberately cheaper by default.
 */
const DEFAULT_MESH_ROUNDS = 2;

export interface RingResult {
  result: string;
  metrics: TopologyMetrics;
}

export interface ExecuteResult {
  result: string | string[];
  metrics: TopologyMetrics;
}

export class TopologyExecutor {
  /**
   * Execute mesh topology: all agents communicate with all others.
   *
   * Runs `maxRounds` rounds (default {@link DEFAULT_MESH_ROUNDS}). In round 0
   * every agent sees the bare task. In each later round an agent additionally
   * receives every *other* agent's output from the previous round — its own
   * prior output is deliberately excluded, which is what makes this all-to-all
   * peer exchange rather than self-refinement.
   *
   * Within a round agents run concurrently via `Promise.allSettled`; the round
   * boundary is the only synchronization point.
   *
   * Failure semantics: a failed call yields an `[error: ...]` placeholder that
   * is carried into the next round as that peer's contribution, so the mesh
   * stays well-formed and index-aligned. A failing agent is *not* ejected — it
   * is retried each round, since failures are frequently transient.
   * `errorCount` counts every failed call across all rounds and can therefore
   * exceed `agentCount`.
   *
   * @returns The final round's outputs, index-aligned with `config.agents`.
   */
  static async executeMesh(
    config: TopologyExecutorConfig
  ): Promise<MeshResult> {
    const { agents, task, signal } = config;
    const maxRounds = config.maxRounds ?? DEFAULT_MESH_ROUNDS;
    const startTime = Date.now();
    let messageCount = 0;
    let errorCount = 0;

    if (agents.length === 0) {
      throw new OrchestrationError(
        "executeMesh() requires at least one agent",
        "topology-mesh"
      );
    }

    TopologyExecutor.checkAborted(signal, "topology-mesh");

    let results: string[] = [];

    for (let round = 0; round < maxRounds; round++) {
      TopologyExecutor.checkAborted(signal, "topology-mesh");

      const previous = results;

      // ORCH-DSL-L1-H-07 — bounded fan-out. Mesh previously issued one
      // simultaneous model call per agent, per round, with no cap.
      // `runConcurrently` preserves input order, which the index-aligned
      // result contract below (and `buildMeshPrompt`) depends on.
      const settled = await runConcurrently(
        agents.map((agent, index) => async () => {
          messageCount++;
          const prompt =
            round === 0
              ? task
              : TopologyExecutor.buildMeshPrompt(task, agents, previous, index);
          const result = await agent.generate(
            [new HumanMessage(prompt)],
            omitUndefined({ signal })
          );
          return result.content;
        }),
        config.maxConcurrency ?? DEFAULT_ORCHESTRATION_FANOUT,
        omitUndefined({ signal })
      );

      const roundResults: string[] = [];
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          roundResults.push(outcome.value);
        } else {
          errorCount++;
          roundResults.push(
            `[error: ${
              outcome.reason instanceof Error
                ? outcome.reason.message
                : String(outcome.reason)
            }]`
          );
        }
      }

      results = roundResults;
    }

    return {
      results,
      metrics: {
        topology: "mesh",
        totalDurationMs: Date.now() - startTime,
        agentCount: agents.length,
        messageCount,
        errorCount,
      },
    };
  }

  /**
   * Build a round-N (N > 0) mesh prompt: the task plus every *other* agent's
   * output from round N-1. The agent's own previous output is excluded so the
   * exchange stays peer-to-peer.
   */
  private static buildMeshPrompt(
    task: string,
    agents: TopologyExecutorConfig["agents"],
    previous: string[],
    selfIndex: number
  ): string {
    const peerBlocks: string[] = [];

    for (let i = 0; i < agents.length; i++) {
      if (i === selfIndex) continue;
      const output = previous[i];
      if (output === undefined) continue;
      peerBlocks.push(
        `${TopologyExecutor.meshPeerLabel(agents, i)}:\n${output}`
      );
    }

    if (peerBlocks.length === 0) {
      return task;
    }

    return `${task}\n\nPeer agent outputs from the previous round:\n\n${peerBlocks.join(
      "\n\n"
    )}`;
  }

  /**
   * Stable, human-readable label for a peer agent. Prefers the agent's `name`
   * (which DzupAgent defaults to its `id`) and falls back to a positional
   * label so the prompt is never ambiguous.
   */
  private static meshPeerLabel(
    agents: TopologyExecutorConfig["agents"],
    index: number
  ): string {
    const name = agents[index]?.name;
    return name !== undefined && name !== "" ? name : `Agent ${index + 1}`;
  }

  /**
   * Execute ring topology: circular pass.
   *
   * Agent 1 processes task, passes output to Agent 2, ..., Agent N.
   * Then loops back (up to maxRounds). Each agent receives the original
   * task plus the previous agent's output.
   */
  static async executeRing(
    config: TopologyExecutorConfig
  ): Promise<RingResult> {
    const { agents, task, signal } = config;
    const maxRounds = config.maxRounds ?? 3;
    const startTime = Date.now();
    let messageCount = 0;
    let errorCount = 0;

    if (agents.length === 0) {
      throw new OrchestrationError(
        "executeRing() requires at least one agent",
        "topology-ring"
      );
    }

    TopologyExecutor.checkAborted(signal, "topology-ring");

    let currentOutput = "";

    for (let round = 0; round < maxRounds; round++) {
      for (const agent of agents) {
        TopologyExecutor.checkAborted(signal, "topology-ring");

        const input = currentOutput
          ? `${task}\n\nPrevious output:\n${currentOutput}`
          : task;

        messageCount++;

        try {
          const result = await agent.generate(
            [new HumanMessage(input)],
            omitUndefined({ signal })
          );
          currentOutput = result.content;
        } catch (err: unknown) {
          errorCount++;
          // On error, keep the previous output and continue
          const errMsg = err instanceof Error ? err.message : String(err);
          currentOutput = currentOutput || `[error: ${errMsg}]`;
        }
      }
    }

    return {
      result: currentOutput,
      metrics: {
        topology: "ring",
        totalDurationMs: Date.now() - startTime,
        agentCount: agents.length,
        messageCount,
        errorCount,
      },
    };
  }

  /**
   * Execute the specified topology.
   *
   * Routes to the appropriate execution method. For hierarchical/pipeline/star,
   * delegates to AgentOrchestrator patterns. For mesh/ring, uses dedicated methods.
   *
   * If autoSwitch is enabled and the error rate exceeds the threshold,
   * re-analyzes and switches topology mid-execution.
   */
  static async execute(
    config: TopologyExecutorConfig & { topology: TopologyType }
  ): Promise<ExecuteResult> {
    const { topology, autoSwitch = false, errorThreshold = 0.5 } = config;

    TopologyExecutor.checkAborted(config.signal, `topology-${topology}`);

    let result: ExecuteResult;
    let initialError: unknown;

    try {
      result = await TopologyExecutor.executeTopology(config, topology);
    } catch (err: unknown) {
      if (!autoSwitch) {
        throw err;
      }
      initialError = err;
      result = TopologyExecutor.createThrownFailureResult(
        config,
        topology,
        err
      );
    }

    // Auto-switch: if error rate is high, re-analyze and try a different topology
    if (
      autoSwitch &&
      result.metrics.agentCount > 0 &&
      TopologyExecutor.errorRate(result.metrics) > errorThreshold
    ) {
      const analyzer = new TopologyAnalyzer();
      const characteristics = TopologyExecutor.inferCharacteristics(
        config,
        topology
      );
      const recommendation = analyzer.analyze(characteristics);
      const retryTopology = TopologyExecutor.selectRetryTopology(
        topology,
        recommendation
      );

      if (retryTopology) {
        try {
          const retryResult = await TopologyExecutor.executeTopology(
            config,
            retryTopology
          );

          retryResult.metrics.switchedFrom = topology;
          return retryResult;
        } catch {
          if (initialError) {
            throw initialError;
          }
          // Retry topology also failed — return original result with switch annotation
          result.metrics.switchedFrom = topology;
          return result;
        }
      }
    }

    if (initialError) {
      throw initialError;
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private static async executeTopology(
    config: TopologyExecutorConfig & { topology: TopologyType },
    topology: TopologyType
  ): Promise<ExecuteResult> {
    switch (topology) {
      case "mesh": {
        const meshResult = await TopologyExecutor.executeMesh(config);
        return { result: meshResult.results, metrics: meshResult.metrics };
      }

      case "ring": {
        const ringResult = await TopologyExecutor.executeRing(config);
        return { result: ringResult.result, metrics: ringResult.metrics };
      }

      case "pipeline": {
        const startTime = Date.now();
        let pipelineErrorCount = 0;
        let pipelineResult: string;
        try {
          pipelineResult = await AgentOrchestrator.sequential(
            config.agents,
            config.task
          );
        } catch (err) {
          pipelineErrorCount = 1;
          throw err;
        }
        return {
          result: pipelineResult,
          metrics: {
            topology: "pipeline",
            totalDurationMs: Date.now() - startTime,
            agentCount: config.agents.length,
            messageCount: config.agents.length,
            errorCount: pipelineErrorCount,
          },
        };
      }

      case "star": {
        const startTime = Date.now();
        let starErrorCount = 0;
        let starResult: string;
        try {
          starResult = await AgentOrchestrator.parallel(
            config.agents,
            config.task
          );
        } catch (err) {
          starErrorCount = 1;
          throw err;
        }
        return {
          result: starResult,
          metrics: {
            topology: "star",
            totalDurationMs: Date.now() - startTime,
            agentCount: config.agents.length,
            messageCount: config.agents.length,
            errorCount: starErrorCount,
          },
        };
      }

      case "hierarchical": {
        // Hierarchical uses the first agent as coordinator, rest as workers
        if (config.agents.length < 2) {
          throw new OrchestrationError(
            "Hierarchical topology requires at least 2 agents (1 coordinator + 1 worker)",
            "topology-hierarchical"
          );
        }
        const startTime = Date.now();
        const [coordinator, ...workers] = config.agents;
        let hierarchicalErrorCount = 0;
        let supervisorResult: SupervisorResult;
        try {
          supervisorResult = await AgentOrchestrator.supervisor(
            omitUndefined({
              manager: coordinator!,
              specialists: workers,
              task: config.task,
              signal: config.signal,
            })
          );
        } catch (err) {
          hierarchicalErrorCount = 1;
          throw err;
        }
        return {
          result: supervisorResult.content,
          metrics: {
            topology: "hierarchical",
            totalDurationMs: Date.now() - startTime,
            agentCount: config.agents.length,
            messageCount: workers.length + 1,
            errorCount: hierarchicalErrorCount,
            // Forward the supervisor's routing decision for observability/audit
            // (W7). Omitted when no routing/circuit-breaker step ran.
            ...(supervisorResult.routingDecisionId !== undefined
              ? { routingDecisionId: supervisorResult.routingDecisionId }
              : {}),
          },
        };
      }

      default: {
        // Exhaustive check
        const _exhaustive: never = topology;
        throw new OrchestrationError(
          `Unknown topology: ${_exhaustive as string}`,
          "topology-mesh"
        );
      }
    }
  }

  /**
   * Error rate in [0, 1] used to gate auto-switching.
   *
   * Multi-round topologies (mesh, ring) accumulate `errorCount` across every
   * round, so dividing by `agentCount` alone would yield a ratio above 1.0 and
   * make a fixed threshold like 0.5 meaningless — a 2-round mesh with a single
   * persistent failure out of 4 agents would score 0.5 instead of its true
   * 0.25. Normalizing by the number of *calls actually made* keeps the value a
   * genuine per-call failure rate and keeps `errorThreshold` comparable across
   * topologies.
   */
  private static errorRate(metrics: TopologyMetrics): number {
    const denominator =
      metrics.messageCount > 0 ? metrics.messageCount : metrics.agentCount;

    if (denominator <= 0) {
      return 0;
    }

    return metrics.errorCount / denominator;
  }

  private static createThrownFailureResult(
    config: TopologyExecutorConfig,
    topology: TopologyType,
    err: unknown
  ): ExecuteResult {
    const errMsg = err instanceof Error ? err.message : String(err);

    return {
      result: `[error: ${errMsg}]`,
      metrics: {
        topology,
        totalDurationMs: 0,
        agentCount: config.agents.length,
        messageCount: TopologyExecutor.estimatedMessageCount(config, topology),
        errorCount: config.agents.length,
      },
    };
  }

  private static estimatedMessageCount(
    config: TopologyExecutorConfig,
    topology: TopologyType
  ): number {
    switch (topology) {
      case "hierarchical":
        return config.agents.length > 0 ? config.agents.length : 0;
      case "pipeline":
      case "star":
        return config.agents.length;
      case "mesh":
        return config.agents.length * (config.maxRounds ?? DEFAULT_MESH_ROUNDS);
      case "ring":
        return config.agents.length * (config.maxRounds ?? 3);
    }
  }

  private static selectRetryTopology(
    failedTopology: TopologyType,
    recommendation: ReturnType<TopologyAnalyzer["analyze"]>
  ): TopologyType | undefined {
    if (recommendation.recommended !== failedTopology) {
      return recommendation.recommended;
    }

    return recommendation.alternatives.find(
      (alternative) => alternative.topology !== failedTopology
    )?.topology;
  }

  /**
   * Infer updated task characteristics that penalize the failed topology,
   * so the analyzer recommends a different one.
   */
  private static inferCharacteristics(
    config: TopologyExecutorConfig,
    _failedTopology: TopologyType
  ): TaskCharacteristics {
    // Build characteristics that steer away from the failed topology
    // by inverting the traits that would have selected it
    return {
      subtaskCount: config.agents.length,
      interdependence: 0.5,
      iterativeRefinement: 0.3,
      coordinationComplexity: 0.3,
      speedPriority: 0.7,
      sequentialNature: 0.3,
    };
  }

  private static checkAborted(
    signal: AbortSignal | undefined,
    pattern: TopologyType | string
  ): void {
    if (signal?.aborted) {
      throw new OrchestrationError(
        `Execution aborted`,
        pattern as "topology-mesh"
      );
    }
  }
}
