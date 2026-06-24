/**
 * Type definitions for the Hono app factory. Split out of `app.ts` so the
 * composition root can stay focused on orchestration. The aggregate
 * {@link ForgeServerConfig} interface is re-exported (along with its
 * dependent option types) from `app.ts` to preserve the public surface.
 *
 * Internally, the configuration is decomposed into focused groups
 * (transport, persistence, runtime, integrations, security, etc.) so that
 * helper modules under `composition/` can ask for narrow slices when the
 * full config is unnecessary.
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
  DurableNodeLedger,
  RunJournal,
  RunStore,
} from "@dzupagent/core/persistence";
import type { CostAwareRouter, ModelRegistry } from "@dzupagent/core/llm";
import type { DzupEventBus } from "@dzupagent/core/events";
import type { MetricsCollector } from "@dzupagent/core/utils";
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

import type { ResourceQuotaManager } from "../security/resource-quota.js";
import type { TenantRunQuota } from "../security/tenant-run-quota.js";
import type { InputGuardConfig } from "../security/input-guard.js";
import type { AuthConfig } from "../middleware/auth.js";
import type { RBACConfig } from "../middleware/rbac.js";
import type { RateLimiterConfig } from "../middleware/rate-limiter.js";
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
import type { DeployRouteConfig } from "../routes/deploy-types.js";
import type { LearningRouteConfig } from "../routes/learning-types.js";
import type { PromptFeedbackLoop } from "../services/prompt-feedback-loop.js";
import type { LearningEventProcessor } from "../services/learning-event-processor.js";
import type { ExecutableAgentResolver } from "../services/executable-agent-resolver.js";
import type { WorkerNodeStore } from "../runtime/worker-registry.js";
import type { DrizzleWorkerNodeDatabase } from "../persistence/drizzle-store-types.js";
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
import type { MailRateLimiterConfig } from "../notifications/mail-rate-limiter.js";
import type { PostgresApiKeyStore } from "../persistence/api-key-store.js";
import type { DrizzleStoreDatabase } from "../persistence/drizzle-store-types.js";
import type { PlaygroundRouteConfig } from "../routes/playground.js";
import type {
  ConnectorTokenProfile,
  GitWorkspaceProfile,
  HttpConnectorProfile,
} from "../runtime/tool-resolver.js";
import type { MetricsAccessControl } from "../routes/metrics.js";
import type { ComplianceAuditStore } from "@dzupagent/core/security";
import type { CostLedgerClient } from "@dzupagent/agent";
import type { CostAttributor } from "../services/cost-attributor.js";

/**
 * Optional mail delivery config. When provided, `createForgeApp` constructs a
 * {@link MailRateLimiter}, {@link DrizzleDlqStore}, and {@link DrizzleMailboxStore}
 * wired together, plus starts a {@link MailDlqWorker} that drains the DLQ on
 * a fixed interval. The resulting mailbox store overrides `mailboxStore` on
 * the server config.
 */
export interface MailDeliveryConfig {
  /** Drizzle DB client used by the DLQ store and mailbox store. */
  db: DrizzleStoreDatabase;
  /** Token-bucket configuration. Defaults to 10 tokens / 10-per-minute refill. */
  rateLimiter?: MailRateLimiterConfig;
  /** DLQ drain interval in milliseconds. Defaults to 10s. */
  dlqWorkerIntervalMs?: number;
  /** DLQ batch size per drain. Defaults to 50. */
  dlqBatchSize?: number;
}

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
 * Structural type matching {@link PromptFeedbackLoop}'s lifecycle API.
 * Uses structural typing so hosts can inject custom implementations or mocks
 * without importing the concrete class.
 *
 * @deprecated Compatibility alias re-exported via `@dzupagent/server/app` for
 * legacy callers. Inline the `{ start(): void; stop(): void }` shape or
 * import `PromptFeedbackLoop` directly. Not part of the package-root public
 * surface (`@dzupagent/server`).
 */
export interface PromptFeedbackLoopLike {
  start(): void;
  stop(): void;
}

/**
 * Structural type matching {@link LearningEventProcessor}'s lifecycle API.
 * Uses structural typing so hosts can inject custom implementations or mocks
 * without importing the concrete class.
 *
 * @deprecated Compatibility alias re-exported via `@dzupagent/server/app` for
 * legacy callers. Inline the `{ start(): void; stop(): void }` shape or
 * import `LearningEventProcessor` directly. Not part of the package-root
 * public surface (`@dzupagent/server`).
 */
export interface LearningEventProcessorLike {
  start(): void;
  stop(): void;
}

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
 * HTTP transport / authentication / rate limiting concerns.
 *
 * @deprecated Internal composition building block for {@link ForgeServerConfig}
 * and {@link ForgeHostRuntimeConfig}. The standalone re-export through
 * `@dzupagent/server/app` is a legacy compatibility alias with zero workspace
 * consumers and is not part of the package-root public surface. Prefer the
 * aggregate `ForgeServerConfig` or `ForgeHostRuntimeConfig` types.
 */
export interface ForgeTransportConfig {
  /**
   * Framework `/api/*` authentication mode.
   *
   * Production hosts must configure this explicitly. Use `mode: 'api-key'`
   * for production deployments. `mode: 'none'` is an intentional local
   * development or legacy compatibility opt-out and emits a startup warning.
   */
  auth?: AuthConfig;
  /**
   * SEC-M-02 escape hatch. By default `auth.mode === 'none'` in production
   * (`NODE_ENV === 'production'`) is refused at startup. Set this to `true` to
   * deliberately run unauthenticated framework `/api/*` routes in production —
   * only for an intentional, reviewed compatibility deployment. Has no effect
   * outside production.
   */
  allowUnsafeNoAuthInProduction?: boolean;
  /** Optional RBAC config (MC-S02). Defaults to API-key role extraction; pass `false` to disable. */
  rbac?: RBACConfig | false;
  /** Optional Postgres API key store. When provided alongside auth.mode='api-key', validate is wired automatically. */
  apiKeyStore?: PostgresApiKeyStore;
  /**
   * Explicit browser origins allowed by CORS. Omit to disable CORS headers.
   * Wildcard (`'*'`) is allowed in development, but production requires
   * `allowWildcardCors: true` for legacy compatibility.
   */
  corsOrigins?: string | string[];
  /** Compatibility opt-in that enables wildcard CORS. Do not use for credentialed browser-token deployments. */
  allowWildcardCors?: boolean;
  /** Safe default HTTP response headers. Pass `false` to disable, or override individual headers. */
  securityHeaders?: SecurityHeadersConfig | false;
  rateLimit?: Partial<RateLimiterConfig>;
  /**
   * Shared JSON request body size protection. Defaults to a conservative
   * framework-wide limit with route-specific allowances for known large
   * payload surfaces. Pass `false` to disable in controlled compatibility
   * hosts.
   */
  jsonBodyLimit?: JsonBodyLimitConfig | false;
}

export interface SecurityHeadersConfig {
  /** Defaults to `nosniff`; pass `false` to disable. */
  xContentTypeOptions?: string | false;
  /** Defaults to `no-referrer`; pass `false` to disable. */
  referrerPolicy?: string | false;
  /** Defaults to `DENY` (clickjacking guard); pass `false` to disable. */
  xFrameOptions?: string | false;
  /**
   * Defaults to `default-src 'self'; base-uri 'self'; frame-ancestors 'none'`
   * (DZUPAGENT-SEC-I-03). Pass `false` to disable, or override with a custom
   * policy when serving HTML that requires external assets.
   */
  contentSecurityPolicy?: string | false;
  /** Additional explicit headers; pass `false` to suppress a header from this map. */
  additionalHeaders?: Record<string, string | false | undefined>;
}

export interface JsonBodyLimitConfig {
  /** Default max JSON body size in bytes. Defaults to 1 MiB. */
  defaultMaxBytes?: number;
  /**
   * Route-specific max JSON body size in bytes. Keys are request paths.
   * A key ending in `*` is treated as a prefix match.
   */
  routeMaxBytes?: Record<string, number>;
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
  /**
   * P2 durable node ledger. When present (with a `runQueue`), the server
   * starts the {@link NodeLedgerReclaimer}, which re-enqueues runs whose
   * nodes have a stale (expired) lease so a live worker resumes them.
   */
  nodeLedger?: DurableNodeLedger;
  /** Tuning for the P2 node-ledger reclaimer (see `nodeLedger`). */
  reclaimer?: {
    /** Sweep interval in ms. Defaults to the reclaimer's own default (15s). */
    intervalMs?: number;
    /** Max stale nodes processed per sweep. Defaults to 50. */
    batchSize?: number;
  };
  runExecutor?: RunExecutor;
  shutdown?: GracefulShutdown;
  metrics?: MetricsCollector;
  /**
   * S4-E: Per-tenant cost showback. When provided, `createForgeApp` mounts
   * `GET /admin/tenants/:tenantId/cost` and `GET /admin/tenants/cost`, which
   * aggregate `cost_cents` from `forge_runs` grouped by tenant. Use
   * {@link DrizzleCostAttributor} for the Postgres-backed implementation.
   */
  costAttributor?: CostAttributor;
  /**
   * P3 distributed guardrail backend. When provided, this Redis-backed
   * {@link CostLedgerClient} (e.g. from
   * {@link createRedisGuardrailClientFromConnection}) is attached to every
   * run's agent spec as the fleet-wide rate-limiter + cost-ledger client and
   * receives the final run cost at completion, so a fleet of worker processes
   * shares one rate-limit window and one spend ceiling. Absent means local-only
   * enforcement, unchanged.
   */
  guardrailClient?: CostLedgerClient;
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
  /**
   * P1 worker fleet registry config. When omitted (and no `db`), the run
   * worker runs in single-node mode with no fleet registration. When present
   * — or when a Drizzle `db` is configured — the worker registers a node,
   * heartbeats, reaps dead peers, and the `/metrics` endpoint exposes fleet
   * gauges fed from the resolved store.
   *
   * Store resolution: explicit `workerRegistry.store` → {@link
   * DrizzleWorkerNodeStore} when `db` is set → {@link InMemoryWorkerNodeStore}.
   */
  workerRegistry?: {
    /** Explicit fleet store. Defaults per `db` (Drizzle) then in-memory. */
    store?: WorkerNodeStore;
    /** Stable id for this worker process. Defaults to a random per-process id. */
    workerId?: string;
    /** Max concurrent runs this node advertises. Default: 5. */
    capacity?: number;
    /** `'shared'` or a tenant id. Default: `'shared'`. */
    tenantScope?: string;
    /** Heartbeat interval ms. Default: 5000. */
    heartbeatMs?: number;
    /** Reaper interval ms. Default: 30000. */
    reaperMs?: number;
    /** Dead-node ttl ms. Default: 30000. */
    ttlMs?: number;
    /** Free-form node metadata (version, host, region). */
    meta?: Record<string, unknown>;
  };
  /**
   * Optional Drizzle client. When provided and `workerRegistry.store` is
   * unset, a {@link DrizzleWorkerNodeStore} is wired as the default fleet
   * store so multiple worker processes share one queryable fleet.
   */
  db?: DrizzleWorkerNodeDatabase;
}

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
  routePlugins?: ServerRoutePlugin<ForgeServerConfig>[];
}

/**
 * Narrow host-runtime config for new `createForgeApp` hosts.
 *
 * Use this type when a host only needs the framework runtime, transport,
 * security, and route-plugin seam. It intentionally excludes the frozen
 * compatibility route-family fields exposed by {@link ForgeServerConfig};
 * app/product routes should keep their own app-owned config and mount through
 * `routePlugins` or app-level Hono composition.
 */
export interface ForgeHostRuntimeConfig
  extends ForgeCoreConfig,
    ForgeTransportConfig,
    ForgeRuntimeConfig,
    ForgeSecurityConfig {
  /**
   * Host-supplied route plugins for app-owned or integration-owned routes.
   * New product-specific route families should use this seam instead of
   * adding fields to `ForgeServerConfig`.
   */
  routePlugins?: ForgeIntegrationsConfig["routePlugins"];
}

/**
 * Security policy: safety monitor, quotas, input guard.
 *
 * @deprecated Internal composition building block for {@link ForgeServerConfig}
 * and {@link ForgeHostRuntimeConfig}. The standalone re-export through
 * `@dzupagent/server/app` is a legacy compatibility alias with zero workspace
 * consumers and is not part of the package-root public surface. Prefer the
 * aggregate `ForgeServerConfig` or `ForgeHostRuntimeConfig` types.
 */
export interface ForgeSecurityConfig {
  /** Skip attaching the built-in runtime safety monitor (default false). */
  disableSafetyMonitor?: boolean;
  /** Per-key resource quota manager (MC-S01). */
  resourceQuota?: ResourceQuotaManager;
  /** Per-tenant concurrent-run cap. When set, each run-creation request checks the tenant's active count. */
  tenantRunQuota?: TenantRunQuota;
  /** MC-S03 input guard configuration. Pass `false` to opt out. */
  security?: {
    inputGuard?: InputGuardConfig | false;
  };
  /**
   * RF-36: Compliance audit store. When provided, a ComplianceAuditLogger is
   * attached to the event bus and all security-relevant events are recorded.
   * Use PostgresAuditStore for durable audit trails in production.
   */
  auditStore?: ComplianceAuditStore;
}

/**
 * Aggregate config object accepted by `createForgeApp`. Decomposed into focused
 * sub-interfaces so individual composition helpers can ask for narrow slices.
 */
export interface ForgeServerConfig
  extends ForgeCoreConfig,
    ForgeTransportConfig,
    ForgeRuntimeConfig,
    ForgeIntegrationsConfig,
    ForgeSecurityConfig {}
