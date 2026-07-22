/**
 * Feature route-family slices of {@link ForgeServerConfig}: the memory,
 * compatibility, evaluation, adapter/MCP, automation, and control-plane route
 * families, plus the aggregate `ForgeRouteFamiliesConfig` and the
 * `ForgeIntegrationsConfig` that adds the route-plugin seam.
 *
 * Split out of `composition/types.ts` so the frozen compatibility route-family
 * surface lives in one focused module. Re-exported from `composition/types.ts`
 * to preserve every existing import path.
 */
import type {
  McpManager,
  McpStdioArgPolicy,
  SkillRegistry,
  WorkflowRegistry,
} from "@dzupagent/core/pipeline";
import type { SkillStepResolver } from "@dzupagent/agent/workflow";
import type { AdapterSkillRegistry } from "@dzupagent/agent-adapters/skills";
import type { ApprovalStateStore } from "@dzupagent/hitl-kit";
import type {
  EvalOrchestratorLike,
  BenchmarkOrchestratorLike,
} from "@dzupagent/eval-contracts";
import type { PresetRegistry } from "@dzupagent/agent/presets";
import type { RunReflectionStore } from "@dzupagent/agent/reflection";
import type { MailboxStore } from "@dzupagent/agent/mailbox";
import type { MemoryServiceLike } from "@dzupagent/memory-ipc";

import type { MemoryHealthRouteConfig } from "../routes/memory-health-types.js";
import type { TokenLifecycleRegistry } from "../routes/run-context-types.js";
import type { RunTraceStore } from "../persistence/run-trace-store.js";
import type { DeployRouteConfig } from "../routes/deploy-types.js";
import type { LearningRouteConfig } from "../routes/learning-types.js";
import type { PromptFeedbackLoop } from "../services/prompt-feedback-loop.js";
import type { LearningEventProcessor } from "../services/learning-event-processor.js";
import type { BenchmarkRouteConfig } from "../routes/benchmarks-types.js";
import type { EvalRouteConfig } from "../routes/evals-types.js";
import type { ServerRoutePlugin } from "../route-plugin.js";
import type { CompileRouteConfig } from "../routes/compile-types.js";
import type { A2ARoutesConfig } from "../routes/a2a-types.js";
import type { AgentCardConfig } from "../a2a/agent-card.js";
import type { A2ATaskStore } from "../a2a/task-handler.js";
import type { TriggerStore } from "../triggers/trigger-store.js";
import type {
  ScheduleStore,
  ClaimedSchedule,
} from "../schedules/schedule-store.js";
import type { ScheduleRouteConfig } from "../routes/schedules.js";
import type { PersonaStore } from "../personas/persona-store.js";
import type { PromptStore } from "../prompts/prompt-store.js";
import type { CatalogStore } from "../marketplace/catalog-store.js";
import type { ClusterStore } from "../persistence/drizzle-cluster-store.js";
import type { OpenAIAuthConfig } from "../routes/openai-compat/auth-middleware.js";
import type { Notifier } from "../notifications/notifier.js";
import type { PlaygroundRouteConfig } from "../routes/playground.js";
import type {
  ConnectorTokenProfile,
  GitWorkspaceProfile,
  HttpConnectorProfile,
} from "../runtime/tool-resolver.js";
import type {
  MailDeliveryConfig,
  PromptFeedbackLoopLike,
  LearningEventProcessorLike,
} from "./config-control-plane.js";

/** Memory and run-history route family config. */
export interface ForgeMemoryRouteFamilyConfig {
  memoryService?: MemoryServiceLike;
  memoryHealth?: MemoryHealthRouteConfig;
  traceStore?: RunTraceStore;
  tokenLifecycleRegistry?: TokenLifecycleRegistry;
}

/** Compatibility and deployment route family config. */
export interface ForgeCompatibilityRouteFamilyConfig {
  playground?: PlaygroundRouteConfig;
  deploy?: DeployRouteConfig;
  /** OpenAI-compatible `/v1/*` HTTP compatibility surface. */
  openai?: {
    /**
     * Mount `/v1/chat/completions` and `/v1/models`.
     *
     * Defaults to false so createForgeApp hosts expose the compatibility API
     * only when they explicitly opt in.
     */
    enabled?: boolean;
    auth?: OpenAIAuthConfig;
  };
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

/** A2A, trigger, and schedule route family config. */
export interface ForgeAutomationRouteFamilyConfig {
  a2a?: {
    agentCardConfig: AgentCardConfig;
    taskStore?: A2ATaskStore;
    onTaskSubmitted?: A2ARoutesConfig["onTaskSubmitted"];
    onTaskContinued?: A2ARoutesConfig["onTaskContinued"];
    pushNotificationUrlPolicy?: A2ARoutesConfig["pushNotificationUrlPolicy"];
  };
  triggerStore?: TriggerStore;
  scheduleStore?: ScheduleStore;
  onScheduleTrigger?: ScheduleRouteConfig["onManualTrigger"];
  /**
   * P4 HA schedule-tick worker config. When provided alongside `scheduleStore`,
   * `createForgeApp` starts a {@link ScheduleTickWorker} that atomically claims
   * due schedule occurrences from the shared store and fires them via `onFire`.
   * Two nodes sharing the same store fire each occurrence exactly once.
   */
  scheduleTickWorker?: {
    /** Identifies this node in claim records. Required for HA. */
    claimerId: string;
    /**
     * Fire a claimed schedule occurrence. Returns the run id created.
     * Wire this to your run-start logic.
     */
    onFire: (claimed: ClaimedSchedule) => Promise<string>;
    /** Tick interval in ms. Defaults to ScheduleTickWorker default (10s). */
    intervalMs?: number;
    /** Max occurrences claimed per tick. Defaults to 50. */
    limit?: number;
    /** Opt-in catch-up: max missed occurrences to replay. Default = skip-and-realign. */
    maxCatchUp?: number;
  };
}

/**
 * Compatibility-only route-family config for legacy server-hosted control
 * planes: prompts, personas, presets, marketplace, reflections, mailbox,
 * clusters, closed-loop processors, and approval state.
 *
 * Do not add new product-control-plane fields here. New app-owned concepts
 * such as workspaces, projects, tasks/subtasks, operator dashboards, personas
 * as product UX, prompt-template product flows, marketplace UX, or memory
 * policy controls should define app-owned config and mount routes through
 * `routePlugins` or app-level Hono composition around `createForgeApp`.
 */
export interface ForgeControlPlaneRouteFamilyConfig {
  /** Compatibility-only prompt route store. New product prompt UX belongs in the consuming app. */
  promptStore?: PromptStore;
  /** Compatibility-only persona route store. New product persona UX belongs in the consuming app. */
  personaStore?: PersonaStore;
  /** Compatibility-only notification integration for existing server routes. */
  notifier?: Notifier;
  /** Compatibility-only preset route registry. New product preset UX belongs in the consuming app. */
  presetRegistry?: PresetRegistry;
  /** Compatibility-only reflection route store. */
  reflectionStore?: RunReflectionStore;
  /** Compatibility-only mailbox route store. */
  mailboxStore?: MailboxStore;
  /** Compatibility-only mailbox delivery wiring. */
  mailDelivery?: MailDeliveryConfig;
  /** Compatibility-only cluster route store. */
  clusterStore?: ClusterStore;
  /** Compatibility-only marketplace catalog route store. New product marketplace UX belongs in the consuming app. */
  catalogStore?: CatalogStore;
  /** Compatibility-only closed-loop prompt processor lifecycle hook. */
  promptFeedbackLoop?: PromptFeedbackLoop | PromptFeedbackLoopLike;
  /** Compatibility-only closed-loop learning processor lifecycle hook. */
  learningEventProcessor?: LearningEventProcessor | LearningEventProcessorLike;
  /** Compatibility-only approval state route store. */
  approvalStore?: ApprovalStateStore;
}

/**
 * Feature-family compatibility surface for existing createForgeApp callers.
 * New product-owned route families should prefer `routePlugins` or app-level
 * Hono composition instead of adding fields here.
 */
export interface ForgeRouteFamiliesConfig
  extends ForgeMemoryRouteFamilyConfig,
    ForgeCompatibilityRouteFamilyConfig,
    ForgeEvaluationRouteFamilyConfig,
    ForgeAdapterRouteFamilyConfig,
    ForgeAutomationRouteFamilyConfig,
    ForgeControlPlaneRouteFamilyConfig {}

/**
 * Optional integrations and feature toggles that mount additional routes.
 *
 * @deprecated Internal composition building block for {@link ForgeServerConfig}.
 * The standalone re-export through `@dzupagent/server/app` is a legacy
 * compatibility alias with zero workspace consumers and is not part of the
 * package-root public surface. Prefer the aggregate `ForgeServerConfig` type,
 * or `ForgeRouteFamiliesConfig` for the families-only slice.
 */
export interface ForgeIntegrationsConfig extends ForgeRouteFamiliesConfig {
  /**
   * Host-supplied route plugins. This is the server-owned extension seam for
   * app/product routes; new product-control-plane endpoints should be composed
   * by the consuming app instead of added as built-in packages/server routes.
   */
  routePlugins?: ServerRoutePlugin[];
}
