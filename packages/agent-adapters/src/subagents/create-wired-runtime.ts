import { typedEmit } from "@dzupagent/core/events";
import type { DzupEventBus } from "@dzupagent/core/events";
import {
  BackgroundSubagentRuntime,
  DurableQueueRunner,
  InMemoryTaskStore,
  PostgresTaskQueue,
  PostgresTaskStore,
  SpawnGate,
  denyAllSpawnPolicy,
  type CheckpointerPort,
  type GovernanceEventSink,
  type LifecyclePolicy,
  type PostgresQueryClient,
  type SpawnApprovalGate,
  type SpawnPolicy,
  type SubagentEventSink,
  type SubagentLogger,
  type TaskStore,
} from "@dzupagent/subagents";
import { randomUUID } from "node:crypto";
import type { ProviderAdapterRegistry } from "../registry/adapter-registry.js";
import type { CheckpointStore } from "../session/workflow-checkpointer.js";
import { CheckpointStorePort } from "./checkpoint-store-port.js";
import { InProcessRunner } from "@dzupagent/subagents";
import {
  RegistrySubagentExecutor,
  type SubagentExecutorLimits,
} from "./registry-subagent-executor.js";

export interface CreateWiredSubagentRuntimeOptions {
  registry: ProviderAdapterRegistry;
  /** Bus to publish `subagent:*` and `governance:*` events on. Optional. */
  eventBus?: DzupEventBus;
  /** Checkpoint store for resumability; wrapped via CheckpointStorePort. */
  checkpointStore?: CheckpointStore;
  /** Custom task store; defaults to in-memory. */
  taskStore?: TaskStore;
  /** Structured logger for runtime, runner, durable stores, and queues. */
  logger?: SubagentLogger;
  /** Durable Postgres-backed task store/queue wiring for production hosts. */
  postgresDurability?: {
    client: PostgresQueryClient;
    taskTableName?: string;
    queueTableName?: string;
    workerId?: string;
    leaseMs?: number;
    pollIntervalMs?: number;
    staleRunningRecovery?: {
      runningTimeoutMs: number;
      action?: "fail" | "requeue";
    };
  };
  policy?: SpawnPolicy;
  approvalGate?: SpawnApprovalGate;
  lifecyclePolicy?: Partial<LifecyclePolicy>;
  /** Per-run executor ceilings (AGENT-M-05 token budget, AGENT-L-11 timeout). */
  executorLimits?: SubagentExecutorLimits;
  generateId?: () => string;
}

/**
 * Assemble a fully-wired {@link BackgroundSubagentRuntime} that runs real
 * subagents through the {@link ProviderAdapterRegistry}, persists via the
 * agent-adapters checkpoint store, and publishes lifecycle + governance events
 * on the framework {@link DzupEventBus}.
 *
 * This is the integration seam: `@dzupagent/subagents` defines the portable
 * runtime + ports; this factory binds the layer-4 concretes (executor,
 * checkpointer, bus) the package cannot import itself.
 */
export function createWiredSubagentRuntime(
  options: CreateWiredSubagentRuntimeOptions,
): BackgroundSubagentRuntime {
  const postgresDurability = options.postgresDurability;
  const store =
    options.taskStore ??
    (postgresDurability
      ? new PostgresTaskStore({
          client: postgresDurability.client,
          ...(postgresDurability.taskTableName
            ? { tableName: postgresDurability.taskTableName }
            : {}),
          ...(options.logger ? { logger: options.logger } : {}),
        })
      : new InMemoryTaskStore());
  const executor = new RegistrySubagentExecutor(
    options.registry,
    options.executorLimits ?? {},
  );

  const events: SubagentEventSink = {
    emit: (event) => {
      if (options.eventBus) {
        typedEmit(options.eventBus, event);
      }
    },
  };

  const governance: GovernanceEventSink = {
    emitGovernance: (event) => {
      if (options.eventBus) {
        typedEmit(options.eventBus, event);
      }
    },
  };

  const checkpointer: CheckpointerPort | undefined = options.checkpointStore
    ? new CheckpointStorePort(options.checkpointStore)
    : undefined;

  const runnerDeps = {
    store,
    executor,
    events,
    clock: { now: () => Date.now() },
    ...(checkpointer ? { checkpointer } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  };
  const queue = postgresDurability
    ? new PostgresTaskQueue({
        client: postgresDurability.client,
        ...(postgresDurability.queueTableName
          ? { tableName: postgresDurability.queueTableName }
          : {}),
        ...(postgresDurability.workerId
          ? { workerId: postgresDurability.workerId }
          : {}),
        ...(postgresDurability.leaseMs
          ? { leaseMs: postgresDurability.leaseMs }
          : {}),
        ...(postgresDurability.pollIntervalMs
          ? { pollIntervalMs: postgresDurability.pollIntervalMs }
          : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      })
    : undefined;
  const runner = queue
    ? new DurableQueueRunner({
        ...runnerDeps,
        queue,
        durable: true,
        horizontal: true,
      })
    : new InProcessRunner(runnerDeps);

  // AGENT-L-10: deny-by-default. A host must pass an explicit `policy` to permit
  // spawns; the wired (production) runtime never ships an allow-all surface.
  const gate = new SpawnGate(
    options.policy ?? denyAllSpawnPolicy,
    options.approvalGate,
  );

  return new BackgroundSubagentRuntime({
    store,
    runner,
    gate,
    events,
    governance,
    ...(options.lifecyclePolicy ? { policy: options.lifecyclePolicy } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(postgresDurability?.staleRunningRecovery
      ? {
          staleRunningRecovery: {
            ...postgresDurability.staleRunningRecovery,
            ...(queue ? { enqueue: (taskId: string) => queue.enqueue(taskId) } : {}),
          },
        }
      : {}),
    generateId: options.generateId ?? (() => randomUUID()),
  });
}
