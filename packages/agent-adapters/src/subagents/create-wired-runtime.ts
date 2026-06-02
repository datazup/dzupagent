import { typedEmit } from "@dzupagent/core/events";
import type { DzupEventBus } from "@dzupagent/core/events";
import {
  BackgroundSubagentRuntime,
  InMemoryTaskStore,
  SpawnGate,
  allowAllSpawnPolicy,
  type CheckpointerPort,
  type GovernanceEventSink,
  type LifecyclePolicy,
  type SpawnApprovalGate,
  type SpawnPolicy,
  type SubagentEventSink,
  type TaskStore,
} from "@dzupagent/subagents";
import { randomUUID } from "node:crypto";
import type { ProviderAdapterRegistry } from "../registry/adapter-registry.js";
import type { CheckpointStore } from "../session/workflow-checkpointer.js";
import { CheckpointStorePort } from "./checkpoint-store-port.js";
import { InProcessRunner } from "@dzupagent/subagents";
import { RegistrySubagentExecutor } from "./registry-subagent-executor.js";

export interface CreateWiredSubagentRuntimeOptions {
  registry: ProviderAdapterRegistry;
  /** Bus to publish `subagent:*` and `governance:*` events on. Optional. */
  eventBus?: DzupEventBus;
  /** Checkpoint store for resumability; wrapped via CheckpointStorePort. */
  checkpointStore?: CheckpointStore;
  /** Custom task store; defaults to in-memory. */
  taskStore?: TaskStore;
  policy?: SpawnPolicy;
  approvalGate?: SpawnApprovalGate;
  lifecyclePolicy?: Partial<LifecyclePolicy>;
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
  options: CreateWiredSubagentRuntimeOptions
): BackgroundSubagentRuntime {
  const store = options.taskStore ?? new InMemoryTaskStore();
  const executor = new RegistrySubagentExecutor(options.registry);

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

  const runner = new InProcessRunner({
    store,
    executor,
    events,
    clock: { now: () => Date.now() },
    ...(checkpointer ? { checkpointer } : {}),
  });

  const gate = new SpawnGate(
    options.policy ?? allowAllSpawnPolicy,
    options.approvalGate
  );

  return new BackgroundSubagentRuntime({
    store,
    runner,
    gate,
    events,
    governance,
    ...(options.lifecyclePolicy ? { policy: options.lifecyclePolicy } : {}),
    generateId: options.generateId ?? (() => randomUUID()),
  });
}
