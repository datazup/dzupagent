# Server API Surface Index

Date: 2026-04-23

Generated from `packages/server/src/index.ts` and `config/server-api-tiers.json`.

## Summary

- Unique export sources in root index: `124`
- Tier counts: stable=`29`, secondary=`28`, experimental=`49`, internal=`18`
- Recommended root exposure: keep-root=`29`, candidate-subpath=`77`, remove-root=`18`

## Current Direct Root Imports

- Imported symbols by tier: stable=`3`, secondary=`9`, experimental=`0`, internal=`0`, unknown=`0`

| Import | Tier | Source Module | Root Exposure | Files | Sample Consumers |
| --- | --- | --- | --- | ---: | --- |
| `ServerRoutePlugin` | `stable` | `./route-plugin.js` | `keep-root` | 7 | `apps/ai-saas-starter-kit/packages/server-domain/src/index.ts`, `apps/ai-saas-starter-kit/packages/server-domain/src/persistence/create-drizzle-domain-config.ts`, `apps/ai-saas-starter-kit/packages/server-domain/src/plugins/ledger-plugin.ts` |
| `ForgeServerConfig` | `stable` | `./app.js` | `keep-root` | 2 | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts`, `dzupagent/packages/agent/src/__tests__/workflow-durability-integration.test.ts` |
| `createForgeApp` | `stable` | `./app.js` | `keep-root` | 1 | `dzupagent/packages/agent/src/__tests__/workflow-durability-integration.test.ts` |
| `DoctorContext` | `secondary` | `./cli/doctor.js` | `candidate-subpath` | 1 | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` |
| `DoctorReport` | `secondary` | `./cli/doctor.js` | `candidate-subpath` | 1 | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` |
| `formatDoctorReportJSON` | `secondary` | `./cli/doctor.js` | `candidate-subpath` | 1 | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` |
| `Grade` | `secondary` | `./scorecard/index.js` | `candidate-subpath` | 1 | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` |
| `IntegrationScorecard` | `secondary` | `./scorecard/index.js` | `candidate-subpath` | 1 | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` |
| `runDoctor` | `secondary` | `./cli/doctor.js` | `candidate-subpath` | 1 | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` |
| `ScorecardProbeInput` | `secondary` | `./scorecard/index.js` | `candidate-subpath` | 1 | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` |
| `ScorecardReport` | `secondary` | `./scorecard/index.js` | `candidate-subpath` | 1 | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` |
| `ScorecardReporter` | `secondary` | `./scorecard/index.js` | `candidate-subpath` | 1 | `apps/ai-saas-starter-kit/scripts/ci-health-check.ts` |

## Root Export Inventory

| Source Module | Tier | Area | Root Exposure | Export Count | Sample Exports |
| --- | --- | --- | --- | ---: | --- |
| `./app.js` | `stable` | `app` | `keep-root` | 4 | `createForgeApp`, `ForgeServerConfig`, `ConsolidationConfig`, `MailDeliveryConfig` |
| `./route-plugin.js` | `stable` | `extensibility` | `keep-root` | 1 | `ServerRoutePlugin` |
| `./routes/runs.js` | `stable` | `routes-core` | `keep-root` | 1 | `createRunRoutes` |
| `./routes/run-context.js` | `secondary` | `trace-context` | `candidate-subpath` | 3 | `createRunContextRoutes`, `TokenLifecycleLike`, `TokenLifecycleRegistry` |
| `./routes/agents.js` | `stable` | `routes-core` | `keep-root` | 2 | `createAgentDefinitionRoutes`, `createAgentRoutes` |
| `./routes/approval.js` | `stable` | `routes-core` | `keep-root` | 1 | `createApprovalRoutes` |
| `./routes/human-contact.js` | `secondary` | `routes-core` | `candidate-subpath` | 1 | `createHumanContactRoutes` |
| `./routes/health.js` | `stable` | `routes-core` | `keep-root` | 1 | `createHealthRoutes` |
| `./routes/memory.js` | `experimental` | `memory` | `candidate-subpath` | 2 | `createMemoryRoutes`, `MemoryRouteConfig` |
| `./routes/memory-browse.js` | `experimental` | `memory` | `candidate-subpath` | 2 | `createMemoryBrowseRoutes`, `MemoryBrowseRouteConfig` |
| `./routes/learning.js` | `experimental` | `learning` | `candidate-subpath` | 2 | `createLearningRoutes`, `LearningRouteConfig` |
| `./routes/benchmarks.js` | `experimental` | `benchmarks` | `candidate-subpath` | 2 | `createBenchmarkRoutes`, `BenchmarkRouteConfig` |
| `./routes/evals.js` | `experimental` | `evals` | `candidate-subpath` | 2 | `createEvalRoutes`, `EvalRouteConfig` |
| `./routes/memory-health.js` | `experimental` | `memory` | `candidate-subpath` | 3 | `createMemoryHealthRoutes`, `MemoryHealthRouteConfig`, `HealthProvider` |
| `./routes/routing-stats.js` | `experimental` | `observability` | `candidate-subpath` | 2 | `createRoutingStatsRoutes`, `RoutingStatsConfig` |
| `./routes/playground.js` | `experimental` | `playground` | `candidate-subpath` | 2 | `createPlaygroundRoutes`, `PlaygroundRouteConfig` |
| `./routes/events.js` | `stable` | `realtime` | `keep-root` | 2 | `createEventRoutes`, `EventRouteConfig` |
| `./routes/workflows.js` | `secondary` | `workflow-routes` | `candidate-subpath` | 2 | `createWorkflowRoutes`, `WorkflowRouteConfig` |
| `./routes/metrics.js` | `secondary` | `metrics` | `candidate-subpath` | 2 | `createMetricsRoute`, `MetricsRouteConfig` |
| `./metrics/prometheus-collector.js` | `secondary` | `metrics` | `candidate-subpath` | 1 | `PrometheusMetricsCollector` |
| `./persistence/postgres-stores.js` | `secondary` | `persistence` | `candidate-subpath` | 7 | `PostgresRunStore`, `PostgresAgentStore`, `DrizzleVectorStore`, `VectorDistanceMetric` |
| `./persistence/drizzle-schema.js` | `internal` | `persistence` | `remove-root` | 17 | `dzipAgents`, `forgeRuns`, `forgeRunLogs`, `forgeVectors` |
| `./persistence/api-key-store.js` | `secondary` | `persistence` | `candidate-subpath` | 5 | `PostgresApiKeyStore`, `hashApiKey`, `generateRawApiKey`, `ApiKeyRecord` |
| `./routes/api-keys.js` | `secondary` | `security-routes` | `candidate-subpath` | 2 | `createApiKeyRoutes`, `ApiKeyRoutesConfig` |
| `./persistence/vector-column.js` | `secondary` | `persistence` | `candidate-subpath` | 1 | `vectorColumn` |
| `./persistence/vector-ops.js` | `secondary` | `persistence` | `candidate-subpath` | 4 | `cosineDistance`, `l2Distance`, `innerProduct`, `toVector` |
| `./persistence/run-trace-store.js` | `secondary` | `persistence` | `candidate-subpath` | 7 | `InMemoryRunTraceStore`, `computeStepDistribution`, `TraceStep`, `RunTrace` |
| `./persistence/drizzle-run-trace-store.js` | `secondary` | `persistence` | `candidate-subpath` | 1 | `DrizzleRunTraceStore` |
| `./persistence/benchmark-run-store.js` | `secondary` | `persistence` | `candidate-subpath` | 5 | `InMemoryBenchmarkRunStore`, `BenchmarkRunRecord`, `BenchmarkBaselineRecord`, `BenchmarkCompareRecord` |
| `./persistence/eval-run-store.js` | `secondary` | `persistence` | `candidate-subpath` | 8 | `InMemoryEvalRunStore`, `EvalRunErrorRecord`, `EvalRunAttemptRecord`, `EvalRunRecord` |
| `./routes/run-trace.js` | `secondary` | `trace-routes` | `candidate-subpath` | 2 | `createRunTraceRoutes`, `RunTraceRouteConfig` |
| `./middleware/auth.js` | `stable` | `middleware` | `keep-root` | 2 | `authMiddleware`, `AuthConfig` |
| `./middleware/rate-limiter.js` | `stable` | `middleware` | `keep-root` | 3 | `rateLimiterMiddleware`, `TokenBucketLimiter`, `RateLimiterConfig` |
| `./middleware/identity.js` | `stable` | `middleware` | `keep-root` | 4 | `identityMiddleware`, `getForgeIdentity`, `getForgeCapabilities`, `IdentityMiddlewareConfig` |
| `./middleware/capability-guard.js` | `stable` | `middleware` | `keep-root` | 1 | `capabilityGuard` |
| `./middleware/rbac.js` | `stable` | `middleware` | `keep-root` | 7 | `rbacMiddleware`, `rbacGuard`, `hasPermission`, `DEFAULT_ROLE_PERMISSIONS` |
| `./middleware/tenant-scope.js` | `stable` | `middleware` | `keep-root` | 3 | `tenantScopeMiddleware`, `getTenantId`, `TenantScopeConfig` |
| `./queue/run-queue.js` | `stable` | `queue` | `keep-root` | 7 | `InMemoryRunQueue`, `RunQueue`, `RunJob`, `RunQueueConfig` |
| `./queue/bullmq-run-queue.js` | `stable` | `queue` | `keep-root` | 2 | `BullMQRunQueue`, `BullMQRunQueueConfig` |
| `./lifecycle/graceful-shutdown.js` | `stable` | `lifecycle` | `keep-root` | 3 | `GracefulShutdown`, `ShutdownConfig`, `ShutdownState` |
| `./lifecycle/human-contact-timeout.js` | `secondary` | `lifecycle` | `candidate-subpath` | 2 | `HumanContactTimeoutScheduler`, `HumanContactTimeoutConfig` |
| `./services/eval-orchestrator.js` | `secondary` | `evals` | `candidate-subpath` | 7 | `EvalOrchestrator`, `EvalExecutionUnavailableError`, `EvalRunInvalidStateError`, `EvalOrchestratorConfig` |
| `./ws/event-bridge.js` | `stable` | `realtime` | `keep-root` | 4 | `EventBridge`, `WSClient`, `ClientFilter`, `EventBridgeConfig` |
| `./ws/control-protocol.js` | `stable` | `realtime` | `keep-root` | 6 | `createWsControlHandler`, `WSControlClientMessage`, `WSControlServerMessage`, `WSControlHandlerOptions` |
| `./ws/authorization.js` | `stable` | `realtime` | `keep-root` | 3 | `createScopedAuthorizeFilter`, `WSClientScope`, `ScopedAuthorizeFilterOptions` |
| `./ws/scope-registry.js` | `stable` | `realtime` | `keep-root` | 1 | `WSClientScopeRegistry` |
| `./ws/scoped-control-handler.js` | `stable` | `realtime` | `keep-root` | 2 | `createScopedWsControlHandler`, `ScopedWsControlHandlerOptions` |
| `./ws/session-manager.js` | `stable` | `realtime` | `keep-root` | 2 | `WSSessionManager`, `WSSessionManagerOptions` |
| `./ws/node-adapter.js` | `stable` | `realtime` | `keep-root` | 3 | `attachNodeWsSession`, `NodeWSLike`, `AttachNodeWsSessionOptions` |
| `./ws/node-upgrade-handler.js` | `stable` | `realtime` | `keep-root` | 4 | `createNodeWsUpgradeHandler`, `createPathUpgradeGuard`, `NodeWebSocketServerLike`, `NodeWsUpgradeHandlerOptions` |
| `./events/event-gateway.js` | `stable` | `realtime` | `keep-root` | 8 | `InMemoryEventGateway`, `EventGateway`, `EventEnvelope`, `EventSubscription` |
| `./notifications/notifier.js` | `experimental` | `notifications` | `candidate-subpath` | 7 | `Notifier`, `classifyEvent`, `Notification`, `NotificationChannel` |
| `./notifications/channels/webhook-channel.js` | `experimental` | `notifications` | `candidate-subpath` | 2 | `WebhookChannel`, `WebhookChannelConfig` |
| `./notifications/channels/console-channel.js` | `experimental` | `notifications` | `candidate-subpath` | 1 | `ConsoleChannel` |
| `./notifications/channels/slack-channel.js` | `experimental` | `notifications` | `candidate-subpath` | 2 | `SlackNotificationChannel`, `SlackNotificationChannelConfig` |
| `./notifications/channels/email-webhook-channel.js` | `experimental` | `notifications` | `candidate-subpath` | 2 | `EmailWebhookNotificationChannel`, `EmailWebhookNotificationChannelConfig` |
| `./notifications/mail-rate-limiter.js` | `experimental` | `notifications` | `candidate-subpath` | 5 | `MailRateLimiter`, `MailRateLimitError`, `DEFAULT_CAPACITY`, `DEFAULT_REFILL_PER_MINUTE` |
| `./notifications/mail-dlq-worker.js` | `experimental` | `notifications` | `candidate-subpath` | 4 | `MailDlqWorker`, `DEFAULT_DLQ_WORKER_INTERVAL_MS`, `DEFAULT_DLQ_WORKER_BATCH_SIZE`, `MailDlqWorkerConfig` |
| `./persistence/drizzle-dlq-store.js` | `internal` | `persistence` | `remove-root` | 6 | `DrizzleDlqStore`, `DLQ_INITIAL_BACKOFF_MS`, `MAX_DLQ_ATTEMPTS`, `computeNextRetryDelayMs` |
| `./persistence/drizzle-mailbox-store.js` | `internal` | `persistence` | `remove-root` | 2 | `DrizzleMailboxStoreOptions`, `DrizzleMailboxStore` |
| `./a2a/index.js` | `experimental` | `a2a` | `candidate-subpath` | 15 | `buildAgentCard`, `InMemoryA2ATaskStore`, `DrizzleA2ATaskStore`, `createA2ARoutes` |
| `./routes/marketplace.js` | `experimental` | `marketplace` | `candidate-subpath` | 2 | `createMarketplaceRoutes`, `MarketplaceRouteConfig` |
| `./marketplace/index.js` | `experimental` | `marketplace` | `candidate-subpath` | 10 | `InMemoryCatalogStore`, `DrizzleCatalogStore`, `CatalogNotFoundError`, `CatalogSlugConflictError` |
| `./routes/memory-sync.js` | `experimental` | `memory` | `candidate-subpath` | 5 | `createMemorySyncRoutes`, `createMemorySyncHandler`, `MemorySyncRouteConfig`, `SyncWebSocket` |
| `./triggers/index.js` | `experimental` | `triggers` | `candidate-subpath` | 6 | `TriggerManager`, `TriggerType`, `TriggerConfig`, `CronTriggerConfig` |
| `./triggers/trigger-store.js` | `experimental` | `triggers` | `candidate-subpath` | 4 | `InMemoryTriggerStore`, `DrizzleTriggerStore`, `TriggerStore`, `TriggerConfigRecord` |
| `./routes/triggers.js` | `experimental` | `triggers` | `candidate-subpath` | 2 | `createTriggerRoutes`, `TriggerRouteConfig` |
| `./routes/schedules.js` | `experimental` | `triggers` | `candidate-subpath` | 2 | `createScheduleRoutes`, `ScheduleRouteConfig` |
| `./schedules/schedule-store.js` | `experimental` | `triggers` | `candidate-subpath` | 4 | `InMemoryScheduleStore`, `DrizzleScheduleStore`, `ScheduleStore`, `ScheduleRecord` |
| `./routes/personas.js` | `experimental` | `personas` | `candidate-subpath` | 2 | `createPersonaRoutes`, `PersonaRouteConfig` |
| `./routes/prompts.js` | `experimental` | `prompts` | `candidate-subpath` | 2 | `createPromptRoutes`, `PromptRouteConfig` |
| `./prompts/prompt-store.js` | `experimental` | `prompts` | `candidate-subpath` | 4 | `InMemoryPromptStore`, `PromptStore`, `PromptVersionRecord`, `PromptStatus` |
| `./personas/persona-store.js` | `experimental` | `personas` | `candidate-subpath` | 3 | `InMemoryPersonaStore`, `PersonaStore`, `PersonaRecord` |
| `./personas/persona-resolver.js` | `experimental` | `personas` | `candidate-subpath` | 2 | `createPersonaStoreResolver`, `PersonaStoreResolver` |
| `./routes/presets.js` | `experimental` | `presets` | `candidate-subpath` | 2 | `createPresetRoutes`, `PresetRouteConfig` |
| `./routes/reflections.js` | `experimental` | `reflections` | `candidate-subpath` | 2 | `createReflectionRoutes`, `ReflectionRouteConfig` |
| `./persistence/drizzle-reflection-store.js` | `internal` | `persistence` | `remove-root` | 1 | `DrizzleReflectionStore` |
| `./routes/mailbox.js` | `experimental` | `notifications` | `candidate-subpath` | 2 | `createMailboxRoutes`, `MailboxRouteConfig` |
| `./persistence/drizzle-cluster-store.js` | `internal` | `persistence` | `remove-root` | 5 | `InMemoryClusterStore`, `DrizzleClusterStore`, `ClusterStore`, `ClusterRecord` |
| `./routes/clusters.js` | `experimental` | `clusters` | `candidate-subpath` | 2 | `createClusterRoutes`, `ClusterRouteConfig` |
| `./routes/openai-compat/index.js` | `secondary` | `compat` | `candidate-subpath` | 26 | `OpenAICompletionMapper`, `createOpenAICompatCompletionsRoute`, `createModelsRoute`, `openaiAuthMiddleware` |
| `./platforms/lambda.js` | `stable` | `platforms` | `keep-root` | 1 | `toLambdaHandler` |
| `./platforms/vercel.js` | `stable` | `platforms` | `keep-root` | 1 | `toVercelHandler` |
| `./platforms/cloudflare.js` | `stable` | `platforms` | `keep-root` | 1 | `toCloudflareHandler` |
| `./cli/plugins-command.js` | `internal` | `cli` | `remove-root` | 4 | `listPlugins`, `addPlugin`, `removePlugin`, `PluginInfo` |
| `./cli/dev-command.js` | `internal` | `cli` | `remove-root` | 3 | `createDevCommand`, `DevCommandConfig`, `DevCommandHandle` |
| `./cli/trace-printer.js` | `internal` | `cli` | `remove-root` | 1 | `TracePrinter` |
| `./cli/config-command.js` | `internal` | `cli` | `remove-root` | 2 | `configValidate`, `configShow` |
| `./cli/memory-command.js` | `internal` | `cli` | `remove-root` | 5 | `memoryBrowse`, `memorySearch`, `MemoryBrowseOptions`, `MemoryBrowseEntry` |
| `./cli/vectordb-command.js` | `internal` | `cli` | `remove-root` | 3 | `vectordbStatus`, `formatVectorDBStatus`, `VectorDBStatusResult` |
| `./cli/doctor.js` | `secondary` | `ops` | `candidate-subpath` | 9 | `runDoctor`, `formatDoctorReport`, `formatDoctorReportJSON`, `CheckStatus` |
| `./cli/marketplace-command.js` | `internal` | `cli` | `remove-root` | 6 | `searchMarketplace`, `filterByCategory`, `formatPluginTable`, `createSampleRegistry` |
| `./cli/scorecard-command.js` | `internal` | `cli` | `remove-root` | 4 | `runScorecard`, `parseScorecardArgs`, `ScorecardCommandOptions`, `ScorecardCommandResult` |
| `./scorecard/index.js` | `secondary` | `ops` | `candidate-subpath` | 14 | `IntegrationScorecard`, `ScorecardReport`, `ScorecardCategory`, `ScorecardCheck` |
| `./runtime/consolidation-scheduler.js` | `secondary` | `runtime` | `candidate-subpath` | 4 | `ConsolidationScheduler`, `ConsolidationTask`, `ConsolidationReport`, `ConsolidationSchedulerConfig` |
| `./services/benchmark-orchestrator.js` | `experimental` | `benchmarks` | `candidate-subpath` | 2 | `BenchmarkOrchestrator`, `BenchmarkOrchestratorConfig` |
| `./runtime/sleep-consolidation-task.js` | `experimental` | `runtime` | `candidate-subpath` | 4 | `createSleepConsolidationTask`, `SleepConsolidationTaskConfig`, `SleepConsolidatorLike`, `SleepConsolidationReportLike` |
| `./runtime/memory-quota-manager.js` | `experimental` | `runtime` | `candidate-subpath` | 1 | `InMemoryQuotaManager` |
| `./runtime/run-worker.js` | `secondary` | `runtime` | `candidate-subpath` | 9 | `startRunWorker`, `RunExecutionContext`, `RunExecutor`, `StartRunWorkerOptions` |
| `./runtime/default-run-executor.js` | `secondary` | `runtime` | `candidate-subpath` | 1 | `createDefaultRunExecutor` |
| `./runtime/dzip-agent-run-executor.js` | `secondary` | `runtime` | `candidate-subpath` | 2 | `createDzupAgentRunExecutor`, `DzupAgentRunExecutorOptions` |
| `./runtime/resource-quota.js` | `secondary` | `runtime` | `candidate-subpath` | 6 | `QuotaExceededError`, `ResourceDimensions`, `ResourceQuota`, `ResourceReservation` |
| `./runtime/retrieval-feedback-hook.js` | `secondary` | `runtime` | `candidate-subpath` | 4 | `reportRetrievalFeedback`, `mapScoreToQuality`, `RetrievalFeedbackSink`, `RetrievalFeedbackHookConfig` |
| `./runtime/tool-resolver.js` | `secondary` | `runtime` | `candidate-subpath` | 10 | `resolveAgentTools`, `ToolResolutionError`, `getToolProfileConfig`, `ToolResolverContext` |
| `./runtime/utils.js` | `secondary` | `runtime` | `candidate-subpath` | 1 | `isStructuredResult` |
| `./deploy/docker-generator.js` | `experimental` | `deploy` | `candidate-subpath` | 4 | `generateDockerfile`, `generateDockerCompose`, `generateDockerignore`, `DockerConfig` |
| `./deploy/health-checker.js` | `experimental` | `deploy` | `candidate-subpath` | 2 | `checkHealth`, `HealthCheckResult` |
| `./deploy/confidence-calculator.js` | `experimental` | `deploy` | `candidate-subpath` | 1 | `DeployConfidenceCalculator` |
| `./deploy/deploy-gate.js` | `experimental` | `deploy` | `candidate-subpath` | 1 | `DeployGate` |
| `./deploy/deployment-history.js` | `experimental` | `deploy` | `candidate-subpath` | 3 | `DeploymentHistory`, `generateDeploymentId`, `resetIdCounter` |
| `./deploy/confidence-types.js` | `experimental` | `deploy` | `candidate-subpath` | 6 | `GateDecision`, `ConfidenceSignal`, `DeployConfidence`, `ConfidenceThresholds` |
| `./deploy/deployment-history-store.js` | `experimental` | `deploy` | `candidate-subpath` | 7 | `PostgresDeploymentHistoryStore`, `InMemoryDeploymentHistoryStore`, `DeploymentHistoryStoreInterface`, `DeploymentHistoryRecord` |
| `./deploy/signal-checkers.js` | `experimental` | `deploy` | `candidate-subpath` | 8 | `checkRecoveryCopilotConfigured`, `checkRollbackAvailable`, `computeAllSignals`, `AgentConfigLike` |
| `./routes/deploy.js` | `experimental` | `deploy` | `candidate-subpath` | 2 | `createDeployRoutes`, `DeployRouteConfig` |
| `./security/incident-response.js` | `experimental` | `security` | `candidate-subpath` | 12 | `IncidentResponseEngine`, `clearIncidentFlags`, `isAgentKilled`, `isToolDisabled` |
| `./docs/doc-generator.js` | `internal` | `docs` | `remove-root` | 3 | `DocGenerator`, `DocGeneratorConfig`, `DocGeneratorContext` |
| `./docs/agent-doc.js` | `internal` | `docs` | `remove-root` | 2 | `renderAgentDoc`, `AgentDocInput` |
| `./docs/tool-doc.js` | `internal` | `docs` | `remove-root` | 2 | `renderToolDoc`, `ToolDocInput` |
| `./docs/pipeline-doc.js` | `internal` | `docs` | `remove-root` | 4 | `renderPipelineDoc`, `PipelineDocInput`, `PipelineDocNode`, `PipelineDocEdge` |
| `./persistence/postgres-registry.js` | `experimental` | `registry` | `candidate-subpath` | 5 | `PostgresRegistry`, `InMemoryRegistryStore`, `PostgresRegistryConfig`, `RegistryStore` |
| `./registry/health-monitor.js` | `experimental` | `registry` | `candidate-subpath` | 3 | `HealthMonitor`, `HealthMonitorConfig`, `ProbeResult` |
| `./routes/registry.js` | `experimental` | `registry` | `candidate-subpath` | 2 | `createRegistryRoutes`, `RegistryRouteConfig` |
| `./streaming/sse-streaming-adapter.js` | `stable` | `realtime` | `keep-root` | 3 | `streamRunHandleToSSE`, `SSEStreamLike`, `StreamRunHandleToSSEOptions` |
| `<local>:dzupagent_SERVER_VERSION` | `internal` | `versioning` | `remove-root` | 1 | `dzupagent_SERVER_VERSION` |

## Notes

- `stable` means keep in the root package unless a strong compatibility reason appears.
- `secondary` means supported, but a candidate for subpath exports to keep the root surface smaller.
- `experimental` means feature-rich or optional planes that should not silently define the default server contract.
- `internal` means the symbol source is currently exposed from the root index but should be treated as a root-surface leak and moved or hidden over time.

Regenerate with `yarn docs:server-api-surface`.
