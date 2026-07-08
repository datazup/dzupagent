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
  type SubagentSpec,
  type TaskStore,
} from "@dzupagent/subagents";
import { createHash, randomUUID } from "node:crypto";
import type { ProviderAdapterRegistry } from "../registry/adapter-registry.js";
import type { CheckpointStore } from "../session/workflow-checkpointer.js";
import { CheckpointStorePort } from "./checkpoint-store-port.js";
import { InProcessRunner } from "@dzupagent/subagents";
import {
  RegistrySubagentExecutor,
  type SubagentExecutorLimits,
  type SubagentPersonaOptions,
} from "./registry-subagent-executor.js";
import type {
  AgentDefinition,
  DzupAgentAgentLoader,
} from "../dzupagent/agent-loader.js";
import type { AdapterProviderId } from "../types.js";

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
  /**
   * Loader used to resolve `.dzupagent/agents` personas at spawn admission and
   * inside the executor. When absent, only registered provider ids (and inline
   * definitions, if enabled) resolve.
   */
  personaLoader?: Pick<
    DzupAgentAgentLoader,
    "loadAgent" | "compileForProvider"
  >;
  /** Permit `agentId: "inline"` subagents carrying an inline definition. */
  allowInline?: boolean;
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
    buildPersonaOptions(options)
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
    options.approvalGate
  );

  return new BackgroundSubagentRuntime({
    store,
    runner,
    gate,
    events,
    governance,
    resolveAdmission: buildAdmissionResolver(options),
    ...(options.lifecyclePolicy ? { policy: options.lifecyclePolicy } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(postgresDurability?.staleRunningRecovery
      ? {
          staleRunningRecovery: {
            ...postgresDurability.staleRunningRecovery,
            ...(queue
              ? { enqueue: (taskId: string) => queue.enqueue(taskId) }
              : {}),
          },
        }
      : {}),
    generateId: options.generateId ?? (() => randomUUID()),
  });
}

/** Persona/inline options threaded into the executor. */
function buildPersonaOptions(
  options: CreateWiredSubagentRuntimeOptions
): SubagentPersonaOptions {
  return {
    ...(options.personaLoader !== undefined
      ? { loader: options.personaLoader }
      : {}),
    ...(options.allowInline !== undefined
      ? { allowInline: options.allowInline }
      : {}),
  };
}

/**
 * Build the trusted spawn-admission resolver. It materializes a persona
 * snapshot (`resolvedDefinition`) for agent ids that map to a `.dzupagent/agents`
 * persona, and captures an audit identity (`personaName`,
 * `inlineDefinitionHash`) for the `subagent:spawned` event. Registered provider
 * ids and inline definitions pass through with only their audit identity.
 */
function buildAdmissionResolver(options: CreateWiredSubagentRuntimeOptions) {
  return async (spec: SubagentSpec) => {
    if (spec.agentId === "inline") {
      return spec.definition !== undefined
        ? {
            spec,
            audit: {
              personaName: spec.definition.name,
              inlineDefinitionHash: hashDefinition(spec.definition),
            },
          }
        : { spec };
    }

    if (
      resolveRegisteredProviderId(options.registry, spec.agentId) !== undefined
    ) {
      return { spec };
    }

    const agent = await options.personaLoader?.loadAgent(spec.agentId);
    if (agent === undefined) {
      return { spec };
    }

    const routedProvider = resolveProviderForAgent(
      options.registry,
      spec,
      agent
    );
    const compiledPrompt = await options.personaLoader!.compileForProvider(
      agent,
      routedProvider
    );
    const resolvedDefinition = {
      name: agent.name,
      personaPrompt: compiledPrompt,
      preferredProvider: routedProvider,
      skillNames: [...agent.skillNames],
      constraints: { ...agent.constraints },
    };

    return {
      spec: {
        ...spec,
        resolvedPersonaName: agent.name,
        resolvedDefinition,
      },
      audit: {
        personaName: agent.name,
        inlineDefinitionHash: hashDefinition(resolvedDefinition),
      },
    };
  };
}

function resolveProviderForAgent(
  registry: ProviderAdapterRegistry,
  spec: SubagentSpec,
  agent: AgentDefinition
): AdapterProviderId {
  if (
    agent.preferredProvider !== undefined &&
    resolveRegisteredProviderId(registry, agent.preferredProvider) !== undefined
  ) {
    return agent.preferredProvider;
  }
  const routed = registry.getForTask({
    prompt:
      typeof spec.input === "string" ? spec.input : JSON.stringify(spec.input),
    tags: [],
    ...(agent.preferredProvider !== undefined
      ? { preferredProvider: agent.preferredProvider }
      : {}),
    systemPrompt: agent.personaPrompt,
    skillIds: agent.skillNames,
  });
  return routed.decision.provider as AdapterProviderId;
}

function resolveRegisteredProviderId(
  registry: ProviderAdapterRegistry,
  agentId: string
): AdapterProviderId | undefined {
  return registry.listAdapters().some((providerId) => providerId === agentId)
    ? (agentId as AdapterProviderId)
    : undefined;
}

function hashDefinition(
  definition: NonNullable<SubagentSpec["definition"]>
): string {
  return `sha256:${createHash("sha256")
    .update(stableStringify(definition))
    .digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableStringify(entryValue)}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
