/**
 * @dzupagent/server/ops — operational diagnostics and health-reporting facade.
 *
 * This subpath gives doctor and scorecard helpers an explicit non-root home
 * while the root entrypoint remains temporarily compatible during migration.
 */

// --- Doctor ---
export { runDoctor, formatDoctorReport, formatDoctorReportJSON } from './cli/doctor.js'
export type {
  CheckStatus,
  CheckResult,
  CheckCategory,
  DoctorReport,
  DoctorOptions,
  DoctorContext,
} from './cli/doctor.js'

// --- Scorecard CLI ---
export { runScorecard, parseScorecardArgs } from './cli/scorecard-command.js'
export type { ScorecardCommandOptions, ScorecardCommandResult } from './cli/scorecard-command.js'

// --- Scorecard API ---
export { IntegrationScorecard } from './scorecard/index.js'
export type {
  ScorecardReport,
  ScorecardCategory,
  ScorecardCheck,
  ScorecardProbeInput,
  Recommendation,
  Grade,
  RecommendationPriority,
} from './scorecard/index.js'
export type { CheckStatus as ScorecardCheckStatus } from './scorecard/index.js'
export { ScorecardReporter, formatConsole, formatMarkdown, formatJSON } from './scorecard/index.js'
export type { ScorecardFormat } from './scorecard/index.js'

// --- Metrics ---
export { createMetricsRoute } from './routes/metrics.js'
export type { MetricsAccessControl, MetricsRouteConfig } from './routes/metrics.js'
export { PrometheusMetricsCollector } from './metrics/prometheus-collector.js'

// --- Persistence / Database Operations ---
export { PostgresRunStore, PostgresAgentStore } from './persistence/postgres-stores.js'
export { PostgresApiKeyStore, hashApiKey, generateRawApiKey } from './persistence/api-key-store.js'
export type { ApiKeyRecord, CreateApiKeyResult } from './persistence/api-key-store.js'
export { createApiKeyRoutes } from './routes/api-keys.js'
export type { ApiKeyRoutesConfig } from './routes/api-keys.js'
export { InMemoryRunTraceStore, computeStepDistribution } from './persistence/run-trace-store.js'
export { DrizzleRunTraceStore } from './persistence/drizzle-run-trace-store.js'
export type {
  TraceStep,
  RunTrace,
  TraceStepDistribution,
  RunTraceStore,
  InMemoryRunTraceStoreOptions,
} from './persistence/run-trace-store.js'
export {
  InMemoryBenchmarkRunStore,
} from './persistence/benchmark-run-store.js'
export type {
  BenchmarkRunRecord,
  BenchmarkBaselineRecord,
  BenchmarkCompareRecord,
  BenchmarkRunStore,
} from './persistence/benchmark-run-store.js'
export { InMemoryEvalRunStore } from './persistence/eval-run-store.js'
export type {
  EvalRunErrorRecord,
  EvalRunAttemptRecord,
  EvalRunRecord,
  EvalRunRecoveryRecord,
  EvalRunStatus,
  EvalRunListFilter,
  EvalRunStore,
} from './persistence/eval-run-store.js'
export {
  DrizzleDlqStore,
  DLQ_INITIAL_BACKOFF_MS,
  MAX_DLQ_ATTEMPTS,
  computeNextRetryDelayMs,
  dlqRowToMessage,
} from './persistence/drizzle-dlq-store.js'
export type { DlqRow } from './persistence/drizzle-dlq-store.js'
export { DrizzleMailboxStore } from './persistence/drizzle-mailbox-store.js'
export type { DrizzleMailboxStoreOptions } from './persistence/drizzle-mailbox-store.js'

// Raw Drizzle schema remains off the package root; hosts that own DB migration
// wiring can import it explicitly through this operational subpath.
export {
  dzipAgents,
  forgeRuns,
  forgeRunLogs,
  deploymentHistory,
  a2aTasks,
  a2aTaskMessages,
  triggerConfigs,
  scheduleConfigs,
  runReflections,
  agentMailbox,
  agentClusters,
  clusterRoles,
  agentCatalog,
  runTraces,
  traceSteps,
  apiKeys,
} from './persistence/drizzle-schema.js'

// --- Deploy / Registry Operations ---
export { generateDockerfile, generateDockerCompose, generateDockerignore } from './deploy/docker-generator.js'
export type { DockerConfig } from './deploy/docker-generator.js'
export { checkHealth } from './deploy/health-checker.js'
export type { HealthCheckResult } from './deploy/health-checker.js'
export { DeployConfidenceCalculator } from './deploy/confidence-calculator.js'
export { DeployGate } from './deploy/deploy-gate.js'
export { DeploymentHistory, generateDeploymentId, resetIdCounter } from './deploy/deployment-history.js'
export type {
  GateDecision,
  ConfidenceSignal,
  DeployConfidence,
  ConfidenceThresholds,
  DeployConfidenceConfig,
  DeploymentRecord,
} from './deploy/confidence-types.js'
export {
  PostgresDeploymentHistoryStore,
  InMemoryDeploymentHistoryStore,
} from './deploy/deployment-history-store.js'
export type {
  DeploymentHistoryStoreInterface,
  DeploymentHistoryRecord,
  DeploymentHistoryInput,
  DeploymentOutcome,
  SuccessRateResult,
} from './deploy/deployment-history-store.js'
export {
  checkRecoveryCopilotConfigured,
  checkRollbackAvailable,
  computeAllSignals,
} from './deploy/signal-checkers.js'
export type {
  AgentConfigLike,
  RollbackCheckResult,
  RollbackChecker,
  SignalComputationResult,
  SignalComputationConfig,
} from './deploy/signal-checkers.js'
export { createDeployRoutes } from './routes/deploy.js'
export type { DeployRouteConfig } from './routes/deploy.js'
export { PostgresRegistry, InMemoryRegistryStore } from './persistence/postgres-registry.js'
export type { PostgresRegistryConfig, RegistryStore, AgentRow } from './persistence/postgres-registry.js'
export { HealthMonitor } from './registry/health-monitor.js'
export type { HealthMonitorConfig, ProbeResult } from './registry/health-monitor.js'
export { createRegistryRoutes } from './routes/registry.js'
export type { RegistryRouteConfig } from './routes/registry.js'

// --- Security Operations ---
export {
  IncidentResponseEngine,
  clearIncidentFlags,
  isAgentKilled,
  isToolDisabled,
  isNamespaceQuarantined,
} from './security/incident-response.js'
export type {
  IncidentAction,
  IncidentTrigger,
  PlaybookAction,
  IncidentPlaybook,
  IncidentActionResult,
  IncidentRecord,
  IncidentResponseConfig,
} from './security/incident-response.js'

// --- Documentation Generation ---
export { DocGenerator } from './docs/doc-generator.js'
export type { DocGeneratorConfig, DocGeneratorContext } from './docs/doc-generator.js'
export { renderAgentDoc } from './docs/agent-doc.js'
export type { AgentDocInput } from './docs/agent-doc.js'
export { renderToolDoc } from './docs/tool-doc.js'
export type { ToolDocInput } from './docs/tool-doc.js'
export { renderPipelineDoc } from './docs/pipeline-doc.js'
export type { PipelineDocInput, PipelineDocNode, PipelineDocEdge } from './docs/pipeline-doc.js'

// --- CLI Helpers ---
export { listPlugins, addPlugin, removePlugin } from './cli/plugins-command.js'
export type { PluginInfo } from './cli/plugins-command.js'
export { createDevCommand } from './cli/dev-command.js'
export type { DevCommandConfig, DevCommandHandle } from './cli/dev-command.js'
export { TracePrinter } from './cli/trace-printer.js'
export { configValidate, configShow } from './cli/config-command.js'
export { memoryBrowse, memorySearch } from './cli/memory-command.js'
export type { MemoryBrowseOptions, MemoryBrowseEntry, MemorySearchResult } from './cli/memory-command.js'
export { vectordbStatus, formatVectorDBStatus } from './cli/vectordb-command.js'
export type { VectorDBStatusResult } from './cli/vectordb-command.js'
export {
  searchMarketplace,
  filterByCategory,
  formatPluginTable,
  createSampleRegistry,
} from './cli/marketplace-command.js'
export type { MarketplacePlugin, MarketplaceRegistry } from './cli/marketplace-command.js'
