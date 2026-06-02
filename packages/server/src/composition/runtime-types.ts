/**
 * Runtime type definitions: execution context, tool connector profiles,
 * agent/model registry wiring, memory/trace route families, eval/adapter
 * route families, and background runtime (queues, executors, journals).
 *
 * These types represent the "running agents" concern — anything that the
 * agent execution pipeline, background workers, or runtime configuration
 * helpers need to reference.
 */
import type {
  AgentRegistry,
  McpManager,
  McpStdioArgPolicy,
  SkillRegistry,
  WorkflowRegistry,
} from "@dzupagent/core/pipeline";
import type {
  AgentExecutionSpecStore,
  RunJournal,
  RunStore,
} from "@dzupagent/core/persistence";
import type { CostAwareRouter, ModelRegistry } from "@dzupagent/core/llm";
import type { DzupEventBus } from "@dzupagent/core/events";
import type { MetricsCollector } from "@dzupagent/core/utils";
import type { SkillStepResolver } from "@dzupagent/agent/workflow";
import type { AdapterSkillRegistry } from "@dzupagent/agent-adapters/skills";
import type {
  EvalOrchestratorLike,
  BenchmarkOrchestratorLike,
} from "@dzupagent/eval-contracts";
import type { MemoryServiceLike } from "@dzupagent/memory-ipc";

import type { RunQueue } from "../queue/run-queue.js";
import type { GracefulShutdown } from "../lifecycle/graceful-shutdown.js";
import type { EventGateway } from "../events/event-gateway.js";
import type { RunExecutor, RunReflectorLike } from "../runtime/run-worker.js";
import type { RetrievalFeedbackHookConfig } from "../runtime/retrieval-feedback-hook.js";
import type { ConsolidationSchedulerConfig } from "../runtime/consolidation-scheduler.js";
import type { SleepConsolidatorLike } from "../runtime/sleep-consolidation-task.js";
import type { MemoryHealthRouteConfig } from "../routes/memory-health-types.js";
import type { TokenLifecycleRegistry } from "../routes/run-context-types.js";
import type { RunTraceStore } from "../persistence/run-trace-store.js";
import type { LearningRouteConfig } from "../routes/learning-types.js";
import type { BenchmarkRouteConfig } from "../routes/benchmarks-types.js";
import type { EvalRouteConfig } from "../routes/evals-types.js";
import type { CompileRouteConfig } from "../routes/compile-types.js";
import type {
  ConnectorTokenProfile,
  GitWorkspaceProfile,
  HttpConnectorProfile,
} from "../runtime/tool-resolver.js";
import type { MetricsAccessControl } from "../routes/metrics.js";
import type { ExecutableAgentResolver } from "../services/executable-agent-resolver.js";

/**
 * Shared scheduling options for consolidation (everything except the task itself
 * and eventBus, which is injected by createForgeApp).
 */
type ConsolidationSchedulingOpts = Omit<
  ConsolidationSchedulerConfig,
  "eventBus" | "task"
>;

/**
 * Consolidation config — supports two modes:
 * 1. Provide an explicit `task` (ConsolidationTask).
 * 2. Provide `consolidator` + `store` + `namespaces` to auto-create the task.
 */
export type ConsolidationConfig =
  | (ConsolidationSchedulingOpts & {
      task: ConsolidationSchedulerConfig["task"];
    })
  | (ConsolidationSchedulingOpts & {
      /** A SleepConsolidator instance (from @dzupagent/memory) */
      consolidator: SleepConsolidatorLike;
      /** A BaseStore instance passed to the consolidator */
      store: unknown;
      /** Namespaces to consolidate */
      namespaces: string[][];
    });

/**
 * Required core wiring: stores, registry, and the shared event bus.
 *
 * @deprecated Internal composition building block for {@link ForgeServerConfig}
 * and {@link ForgeHostRuntimeConfig}. The standalone re-export through
 * `@dzupagent/server/app` is a legacy compatibility alias with zero workspace
 * consumers and is not part of the package-root public surface. Prefer the
 * aggregate `ForgeServerConfig` or `ForgeHostRuntimeConfig` types.
 */
export interface ForgeCoreConfig {
  runStore: RunStore;
  agentStore: AgentExecutionSpecStore;
  /** Optional registry control plane for registry-backed management and execution projection. */
  registry?: AgentRegistry;
  /** Optional boundary that resolves a runnable execution spec for a run or compatibility API. */
  executableAgentResolver?: ExecutableAgentResolver;
  eventBus: DzupEventBus;
  modelRegistry: ModelRegistry;
}

/**
 * Background runtime: queues, executors, journals, scheduler, lifecycle hooks.
 *
 * @deprecated Internal composition building block for {@link ForgeServerConfig}
 * and {@link ForgeHostRuntimeConfig}. The standalone re-export through
 * `@dzupagent/server/app` is a legacy compatibility alias with zero workspace
 * consumers and is not part of the package-root public surface. Prefer the
 * aggregate `ForgeServerConfig` or `ForgeHostRuntimeConfig` types.
 */
export interface ForgeRuntimeConfig {
  runQueue?: RunQueue;
  runExecutor?: RunExecutor;
  shutdown?: GracefulShutdown;
  metrics?: MetricsCollector;
  /**
   * Prometheus `/metrics` endpoint exposure policy. The endpoint is not mounted
   * unless this is configured, so public scraping requires an explicit
   * `unsafe-public` opt-in.
   */
  prometheusMetrics?: {
    access: MetricsAccessControl;
  };
  eventGateway?: EventGateway;
  consolidation?: ConsolidationConfig;
  router?: CostAwareRouter;
  reflector?: RunReflectorLike;
  retrievalFeedback?: RetrievalFeedbackHookConfig;
  journal?: RunJournal;
}

/** Memory and run-history route family config. */
export interface ForgeMemoryRouteFamilyConfig {
  memoryService?: MemoryServiceLike;
  memoryHealth?: MemoryHealthRouteConfig;
  traceStore?: RunTraceStore;
  tokenLifecycleRegistry?: TokenLifecycleRegistry;
}

/** Learning, evaluation, and benchmark route family config. */
export interface ForgeEvaluationRouteFamilyConfig {
  learning?: LearningRouteConfig;
  benchmark?: BenchmarkRouteConfig;
  evals?: EvalRouteConfig;
  evalOrchestrator?: EvalOrchestratorLike;
  benchmarkOrchestrator?: BenchmarkOrchestratorLike;
}

/** Adapter, MCP, skill, workflow, and compile route family config. */
export interface ForgeAdapterRouteFamilyConfig {
  mcpManager?: McpManager;
  /** Allowlist for stdio MCP server registration. */
  mcpAllowedExecutables?: string[];
  /**
   * Policy for validating stdio MCP command arguments. Defaults to `'strict'`,
   * which rejects interpreter inline-eval invocations (e.g. `node -e …`) even
   * when the executable is allowlisted. Set to `'legacy'` only for fully
   * trusted, pre-existing configs.
   */
  mcpStdioArgPolicy?: McpStdioArgPolicy;
  /** Allowlist for private/loopback/link-local MCP HTTP/SSE hosts. */
  mcpAllowedHttpHosts?: string[];
  /** Server-owned HTTP connector profiles keyed by profile name. */
  httpConnectorProfiles?: Record<string, HttpConnectorProfile>;
  /** Default HTTP connector profile name used by built-in tool resolution. */
  defaultHttpConnectorProfile?: string;
  /** Server-owned GitHub connector token profiles keyed by profile name. */
  githubConnectorProfiles?: Record<string, ConnectorTokenProfile>;
  /** Default GitHub connector profile name used by built-in tool resolution. */
  defaultGithubConnectorProfile?: string;
  /** Server-owned Slack connector token profiles keyed by profile name. */
  slackConnectorProfiles?: Record<string, ConnectorTokenProfile>;
  /** Default Slack connector profile name used by built-in tool resolution. */
  defaultSlackConnectorProfile?: string;
  /** Server-owned Git workspace profiles keyed by profile name. */
  gitWorkspaceProfiles?: Record<string, GitWorkspaceProfile>;
  /** Default Git workspace profile name used by built-in tool resolution. */
  defaultGitWorkspaceProfile?: string;
  /**
   * Unsafe compatibility escape hatch for legacy run metadata HTTP connector
   * configuration. Keep disabled for untrusted run metadata.
   */
  allowUnsafeMetadataHttpConnector?: boolean;
  /**
   * Unsafe compatibility escape hatch for legacy metadata.cwd Git tool
   * selection. The cwd remains root-contained by the selected workspace.
   */
  allowUnsafeMetadataGitCwd?: boolean;
  skillRegistry?: AdapterSkillRegistry;
  coreSkillRegistry?: SkillRegistry;
  workflowRegistry?: WorkflowRegistry;
  skillStepResolver?: SkillStepResolver;
  compile?: CompileRouteConfig;
}
