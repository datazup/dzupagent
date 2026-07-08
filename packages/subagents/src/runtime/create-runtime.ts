import { randomUUID } from "node:crypto";
import { systemClock } from "../contracts/clock.js";
import type { Clock } from "../contracts/clock.js";
import type { CheckpointerPort } from "../contracts/checkpointer-port.js";
import type { SubagentEventSink } from "../contracts/events.js";
import type { SubagentExecutorPort } from "../contracts/subagent-executor-port.js";
import type { TaskRunner } from "../contracts/task-runner.js";
import type { TaskStore } from "../contracts/task-store.js";
import { SpawnGate, denyAllSpawnPolicy } from "../governance/spawn-gate.js";
import type {
  SpawnApprovalGate,
  SpawnPolicy,
} from "../governance/spawn-gate.js";
import { InProcessRunner } from "../runner/in-process-runner.js";
import { InMemoryTaskStore } from "../store/in-memory-task-store.js";
import {
  BackgroundSubagentRuntime,
  type GovernanceEventSink,
  type SubagentAdmissionResolver,
} from "./background-subagent-runtime.js";
import type { LifecyclePolicy } from "./runtime-config.js";

/** Deps handed to a custom runner factory. */
export interface RunnerFactoryDeps {
  store: TaskStore;
  executor: SubagentExecutorPort;
  events: SubagentEventSink;
  clock: Clock;
  checkpointer?: CheckpointerPort;
}

/**
 * Options for the default in-process runtime wiring. The only required inputs are
 * the {@link SubagentExecutorPort} (how a subagent actually runs) and an event
 * sink; everything else has a safe default and can be overridden.
 */
export interface CreateInProcessRuntimeOptions {
  executor: SubagentExecutorPort;
  events: SubagentEventSink;
  store?: TaskStore;
  checkpointer?: CheckpointerPort;
  policy?: SpawnPolicy;
  approvalGate?: SpawnApprovalGate;
  governance?: GovernanceEventSink;
  resolveAdmission?: SubagentAdmissionResolver;
  lifecyclePolicy?: Partial<LifecyclePolicy>;
  clock?: Clock;
  generateId?: () => string;
  /** Provide a custom runner factory to use a non-default execution substrate. */
  runnerFactory?: (deps: RunnerFactoryDeps) => TaskRunner;
}

/**
 * Wire a ready-to-use in-process {@link BackgroundSubagentRuntime} with sensible
 * defaults. For durable/horizontal execution, pass a `runnerFactory` that builds
 * a `DurableQueueRunner`, or construct the runtime manually.
 */
export function createInProcessSubagentRuntime(
  options: CreateInProcessRuntimeOptions
): BackgroundSubagentRuntime {
  const store = options.store ?? new InMemoryTaskStore();
  const clock = options.clock ?? systemClock;
  // AGENT-H-03 / SEC-M-05: fail closed. A caller that wants unbounded spawning
  // must pass an explicit policy (allowAllSpawnPolicy is test-only). Defaulting to
  // allow-all let any consumer of this base runtime spawn with no tenant scope.
  const gate = new SpawnGate(
    options.policy ?? denyAllSpawnPolicy,
    options.approvalGate
  );

  const runnerDeps: RunnerFactoryDeps = {
    store,
    executor: options.executor,
    events: options.events,
    clock,
    ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
  };
  const runner = options.runnerFactory
    ? options.runnerFactory(runnerDeps)
    : new InProcessRunner(runnerDeps);

  return new BackgroundSubagentRuntime({
    store,
    runner,
    gate,
    events: options.events,
    ...(options.governance ? { governance: options.governance } : {}),
    ...(options.resolveAdmission !== undefined
      ? { resolveAdmission: options.resolveAdmission }
      : {}),
    ...(options.lifecyclePolicy ? { policy: options.lifecyclePolicy } : {}),
    clock,
    generateId: options.generateId ?? (() => randomUUID()),
  });
}
