/**
 * Drizzle ORM schema for DzupAgent server persistence.
 *
 * Tables are prefixed with `forge_` to avoid collision with application
 * tables when deployed alongside other Drizzle/Prisma schemas.
 *
 * This module is a barrel: the table definitions live in domain-grouped leaf
 * files under `./drizzle-schema/`, re-exported here so the export surface
 * (and the `drizzle.config.ts` `schema` path) stays identical. `drizzle-kit`
 * discovers every exported `pgTable` transitively through these re-exports.
 */
export {
  dzipAgents,
  forgeRuns,
  forgeRunLogs,
  runArtifacts,
} from "./drizzle-schema/runs.js";

export { a2aTasks, a2aTaskMessages } from "./drizzle-schema/a2a.js";

export {
  triggerConfigs,
  scheduleConfigs,
  flowJobs,
} from "./drizzle-schema/scheduling.js";

export {
  agentClusters,
  clusterRoles,
  agentMailbox,
  agentMailDlq,
} from "./drizzle-schema/clusters-mailbox.js";

export {
  forgeNodeLedger,
  flowNodeAdapterMeta,
  workerNodes,
  flowArtifacts,
  flowEvents,
  flowApprovals,
} from "./drizzle-schema/flow-runtime.js";

export {
  deploymentHistory,
  runReflections,
  runTraces,
  traceSteps,
  auditLog,
} from "./drizzle-schema/observability.js";

export { agentCatalog, apiKeys } from "./drizzle-schema/catalog-api-keys.js";
