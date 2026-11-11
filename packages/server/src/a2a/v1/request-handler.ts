import { randomUUID } from "node:crypto";
import { Task, TaskState, taskStateToJSON } from "@a2a-js/sdk";
import type { AgentCard, CancelTaskRequest, GetTaskRequest, SendMessageRequest } from "@a2a-js/sdk";
import { JsonRpcTaskNotCancelableError } from "@a2a-js/sdk/errors";
import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  AgentEvent,
  RequestContext,
  ServerCallContext as SdkServerCallContext,
} from "@a2a-js/sdk/server";
import type { AgentExecutor, ExecutionEventBus, ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import type { Context } from "hono";
import { logRouteError } from "../../routes/route-error.js";
import { dzupOwnerResolver } from "./identity.js";
import type { A2AV1Recovery, OperationRow } from "./operation-store.js";
import { CANCEL_REFUSED_TEXT, OperationRefusedError, RECOVERY_REQUIRED_TEXT, cancelGuardRefuses, isDispatchOutstanding, shouldProjectRecovery } from "./recovery-port.js";
import { requestStopSafely, resolveClaimedOperation } from "./recovery-scanner.js";

export type { AgentExecutor, TaskStore } from "@a2a-js/sdk/server";

export interface A2AV1Config {
  executor: AgentExecutor;
  taskStore?: TaskStore;
  /** M3a: one instance per process boot (see createA2AV1Recovery). Absent = M2 behaviour, unchanged. */
  recovery?: A2AV1Recovery;
}

export interface A2AV1HandlerConfig extends A2AV1Config {
  agentCard: AgentCard;
}

export interface A2AV1Handler {
  handler: JsonRpcTransportHandler;
  card: AgentCard;
}

/** Set by the safe executor per call; the executor reads its own operation key here. */
const OPERATION_KEY_STATE = "dzup.a2a.operationKey";

class DzupRequestHandler extends DefaultRequestHandler {
  recovery?: A2AV1Recovery;

  /**
   * A retry of a messageId whose operation already has a recovery state is refused before the SDK runs: an executor rejection would
   * make the SDK persist a synthetic FAILED over a task whose Worker effect is attached or unproven.
   */
  private async refuseRetryUnderRecovery(params: SendMessageRequest, context: ServerCallContext): Promise<void> {
    const recovery = this.recovery;
    const message = params.message;
    if (!recovery || !message?.taskId || !message.messageId) return;
    let refused: boolean;
    try {
      refused = await recovery.retryUnderRecovery(context, message.taskId, message.messageId);
    } catch (error) {
      throw logAndSanitize(context, "a2a.v1.recovery", error);
    }
    if (refused) throw new Error(GENERIC_ERROR);
  }

  override async sendMessage(params: SendMessageRequest, context: ServerCallContext) {
    await this.refuseRetryUnderRecovery(params, context);
    return super.sendMessage(params, context);
  }

  override async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext) {
    await this.refuseRetryUnderRecovery(params, context);
    yield* super.sendMessageStream(params, context);
  }

  override async getTask(params: GetTaskRequest, context: ServerCallContext) {
    const task = await super.getTask(params, context);
    const recovery = this.recovery;
    if (!recovery) return task;
    // Projection happens here, never in store.load: the SDK re-saves a loaded task and a marker would be persisted.
    let operation;
    try {
      operation = await recovery.latest(context, task.id);
    } catch (error) {
      throw logAndSanitize(context, "a2a.v1.recovery", error);
    }
    if (!shouldProjectRecovery(operation, taskStateToJSON(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED))) return task;
    const json = Task.toJSON(task) as Record<string, unknown>;
    json.status = {
      ...(json.status as Record<string, unknown>),
      message: { messageId: "dzup-recovery-required", role: "ROLE_AGENT", parts: [{ text: RECOVERY_REQUIRED_TEXT, mediaType: "text/plain" }] },
    };
    json.metadata = { ...((json.metadata as Record<string, unknown> | undefined) ?? {}), dzupRecovery: "required" };
    return Task.fromJSON(json);
  }

  override async cancelTask(params: CancelTaskRequest, context: ServerCallContext) {
    // The SDK makes repeat cancellation idempotent. M1 requires -32002 for
    // every terminal task, including one already canceled. getTask preserves
    // the SDK's owner/tenant check and not-found response before this check.
    const task = await super.getTask({ id: params.id, tenant: "" }, context);
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
      throw new JsonRpcTaskNotCancelableError();
    }
    const recovery = this.recovery;
    if (recovery) {
      const taskState = taskStateToJSON(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED);
      let operation;
      try {
        operation = await recovery.latest(context, task.id);
      } catch {
        throw logFixedAndSanitize(context, "a2a.v1.recovery.cancel");
      }
      if (recovery.port !== undefined && typeof recovery.claimCancel === "function") {
        // M3b: with a port the handler-owned cancel flow supersedes the guard, but only while a dispatch can still be outstanding.
        // INPUT_REQUIRED and AUTH_REQUIRED keep the M2 synthetic cancel (no Worker effect to stop), except behind a held-back cancel.
        if (operation && isDispatchOutstanding(taskState)) return this.cancelWithPropagation(params, context, task, recovery);
        if (operation?.state === "cancel_pending" && !isTerminalState(taskState)) throw new JsonRpcTaskNotCancelableError({ message: CANCEL_REFUSED_TEXT });
      } else if (cancelGuardRefuses(operation, taskState, recovery.bootId)) {
        throw new JsonRpcTaskNotCancelableError({ message: CANCEL_REFUSED_TEXT });
      }
    }
    return super.cancelTask(params, context);
  }

  /**
   * Handler-owned cancel: a durable cancel intent (the claim), the hold-back of the SDK's own CANCELED save, the SDK's cancel path (a live
   * task's executor is called by the SDK; an orphan has no bus and is not), one optional stop request, then ONE inspect. CANCELED is
   * written only on a receipted `stopped` or `not_applied`; anything uncertain leaves `recovery_required` and the stored task is returned.
   */
  private async cancelWithPropagation(params: CancelTaskRequest, context: ServerCallContext, task: Task, recovery: A2AV1Recovery) {
    let claimed: OperationRow | undefined;
    const token = randomUUID();
    try {
      claimed = await recovery.claimCancel(context, task.id, token);
      if (!claimed) {
        // Nothing claimable: a resolved operation of a still non-terminal task is the M2 path; an unexpired claim by another actor, a
        // superseded generation or anything else is -32002 (the wire text is the M1 fixed one).
        const current = await recovery.latest(context, task.id);
        if (current?.state === "resolved") return super.cancelTask(params, context);
      }
    } catch {
      throw logFixedAndSanitize(context, "a2a.v1.recovery.cancel");
    }
    if (!claimed) throw new JsonRpcTaskNotCancelableError({ message: CANCEL_REFUSED_TEXT });
    try {
      await super.cancelTask(params, context);
    } catch (error) {
      // The SDK saves CANCELED itself; the hold-back drops that save and the SDK then raises TaskNotCancelableError (recognised by name or
      // reason, never instanceof: the server bundle and @a2a-js/sdk/errors each define their own class). Any error other than a missing
      // task, including a generic one from a rejecting executor, leaves the claim held and the flow continues to the inspect.
      if (isTaskNotFound(error)) throw error;
    }
    try {
      const now = await super.getTask({ id: task.id, tenant: "" }, context);
      if (!isTerminalState(taskStateToJSON(now.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED))) {
        await requestStopSafely(recovery, recovery.port, claimed, recovery.inspectTimeoutMs);
      }
      await resolveClaimedOperation(recovery, claimed, token, recovery.port, recovery.inspectTimeoutMs);
    } catch {
      throw logFixedAndSanitize(context, "a2a.v1.recovery.cancel");
    }
    // The stored task is the truth (never the SDK's object): CANCELED only on a receipted stop; a task that finished first is -32002.
    const stored = await this.getTask({ id: task.id, tenant: "" }, context);
    const storedState = stored.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
    if (storedState === TaskState.TASK_STATE_CANCELED) return stored;
    if (isTerminalState(taskStateToJSON(storedState))) throw new JsonRpcTaskNotCancelableError({ message: CANCEL_REFUSED_TEXT });
    return stored;
  }
}

const TERMINAL_NAMES = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"]);
const isTerminalState = (state: string): boolean => TERMINAL_NAMES.has(state);

/** By name or reason: the SDK's error classes are defined twice (server bundle and @a2a-js/sdk/errors), so instanceof is unreliable. */
function isTaskNotFound(error: unknown): boolean {
  try {
    const e = error as { name?: unknown; toErrorInfo?: () => { reason?: unknown } };
    const reason = typeof e?.toErrorInfo === "function" ? e.toErrorInfo().reason : undefined;
    return e?.name === "TaskNotFoundError" || reason === "TASK_NOT_FOUND";
  } catch {
    return false;
  }
}

const GENERIC_ERROR = "Internal server error";

/**
 * M3b: the cancel path logs only a fixed, payload-free record (the label), never the original error: no message, stack, id or scope reaches
 * the logger. Total like logAndSanitize.
 */
function logFixedAndSanitize(context: ServerCallContext | undefined, label: string): Error {
  try {
    const route = context?.state.get("dzup.a2a.route") as Context | undefined;
    const requestInfo = route ?? { req: { method: "POST", path: "/a2a" } as Context["req"] };
    const fixed = new Error(`${label} failed`);
    fixed.stack = `${fixed.name}: ${fixed.message}`;
    logRouteError(requestInfo, label, fixed);
    return new Error(GENERIC_ERROR);
  } catch {
    return new Error(GENERIC_ERROR);
  }
}

/** Total: a hostile error object (throwing getters, toJSON) must never escape or leak. */
function logAndSanitize(context: ServerCallContext | undefined, label: string, error: unknown): Error {
  try {
    const route = context?.state.get("dzup.a2a.route") as Context | undefined;
    const requestInfo = route ?? { req: { method: "POST", path: "/a2a" } as Context["req"] };
    logRouteError(requestInfo, label, error);
    return new Error(GENERIC_ERROR);
  } catch {
    return new Error(GENERIC_ERROR);
  }
}

const EVENT_KINDS = new Set(["task", "message", "statusUpdate", "artifactUpdate"]);
const SDK_FAILURE_PREFIXES = ["Event processing loop failed:", "Agent execution error:"];

/**
 * Single choke point: the SDK persists "Event processing loop failed: <message>"
 * into FAILED status and history. Whatever raised the message, a persisted copy
 * only ever carries the generic safe text; the original is logged first.
 * Mutates in place so the SDK's in-memory current task matches what is stored.
 */
function redactSdkFailureText(task: Task, context: ServerCallContext): void {
  const messages = [task.status?.message, ...(task.history ?? [])];
  for (const message of messages) {
    for (const part of message?.parts ?? []) {
      const content = part.content;
      if (content?.$case !== "text") continue;
      const prefix = SDK_FAILURE_PREFIXES.find((p) => content.value.startsWith(p));
      if (prefix !== undefined) {
        const error = logAndSanitize(context, "a2a.v1.persisted-failure", new Error(content.value));
        content.value = `${prefix} ${error.message}`;
      }
    }
  }
}

type PartCarrier = { parts?: Array<{ content?: { $case?: string } }> } | undefined;

/** The admitted surface is text only: every part an executor publishes must be a text part. */
function assertTextOnlyEvent(kind: string, data: Record<string, unknown>): void {
  const carriers: PartCarrier[] = [];
  const status = data.status as { message?: PartCarrier } | undefined;
  if (kind === "message") carriers.push(data as PartCarrier);
  if (status?.message) carriers.push(status.message);
  for (const message of (data.history as PartCarrier[] | undefined) ?? []) carriers.push(message);
  const artifacts = [...((data.artifacts as PartCarrier[] | undefined) ?? [])];
  if (data.artifact) artifacts.push(data.artifact as PartCarrier);
  carriers.push(...artifacts);
  for (const carrier of carriers) {
    // A2A 1.0: parts are required, at least one. The store rejects empty parts, so reject them here too.
    if (!carrier?.parts?.length) throw new Error("A2A v1 requires at least one part")
    for (const part of carrier.parts) {
      if (part?.content?.$case !== "text") throw new Error("A2A v1 only serves text parts");
    }
  }
}

/** Copies the host-visible request context so the executor cannot mutate state the SDK reads later. */
function copyRequestContext(request: RequestContext, operationKey?: string): RequestContext {
  let context = request.context;
  if (operationKey !== undefined) {
    // Per-call copy with its own state Map: an executor that replaces the entry changes only its own call.
    const state = new Map(request.context.state);
    state.set(OPERATION_KEY_STATE, operationKey);
    context = new SdkServerCallContext({
      requestedExtensions: request.context.requestedExtensions, user: request.context.user, tenant: request.context.tenant,
      requestedVersion: request.context.requestedVersion, state,
    });
  }
  return new RequestContext(
    structuredClone(request.request),
    request.taskId,
    request.contextId,
    context,
    request.task ? structuredClone(request.task) : undefined,
    request.referenceTasks ? structuredClone(request.referenceTasks) : undefined
  );
}

/**
 * Events are detached (structured-cloned) at the bus boundary so a hostile
 * getter or unclonable value fails here, inside the executor call, where the
 * failure is logged and replaced by the generic message, not later inside the
 * SDK's background loop.
 */
function sanitizeEventBus(bus: ExecutionEventBus, context: ServerCallContext | undefined, label: string, fixedLogs = false): ExecutionEventBus {
  const failure = (error: unknown): Error => (fixedLogs ? logFixedAndSanitize(context, label) : logAndSanitize(context, label, error));
  // Host listeners get a detached copy of each event and cannot throw into the SDK's dispatch.
  const guarded = new WeakMap<object, (...args: unknown[]) => void>();
  const guard = (listener: unknown): never => {
    const fn = listener as (...args: unknown[]) => void;
    let safe = guarded.get(fn);
    if (!safe) {
      safe = (...args: unknown[]) => {
        try {
          fn(...args.map((arg) => (typeof arg === "object" && arg !== null ? structuredClone(arg) : arg)));
        } catch (error) {
          failure(error);
        }
      };
      guarded.set(fn, safe);
    }
    return safe as never;
  };
  const wrapped: ExecutionEventBus = {
    publish(event) {
      let detached: typeof event;
      try {
        // Read each field once and publish a fresh object: no getter, accessor or
        // unknown kind from the host ever reaches the SDK's listeners or switch.
        const { kind, data } = event as { kind: unknown; data: unknown };
        if (!EVENT_KINDS.has(kind as string) || typeof data !== "object" || data === null || Array.isArray(data)) {
          throw new Error("invalid A2A v1 executor event");
        }
        const cloned = structuredClone(data);
        assertTextOnlyEvent(kind as string, cloned as Record<string, unknown>);
        // A first returnImmediately response is the detached event itself, not the stored copy.
        if (kind === "task" && context) redactSdkFailureText(cloned as Task, context);
        detached = { kind, data: cloned } as typeof event;
      } catch (error) {
        throw failure(error);
      }
      bus.publish(detached);
    },
    on(eventName: never, listener: never) { bus.on(eventName, guard(listener)); return wrapped; },
    off(eventName: never, listener: never) { bus.off(eventName, guard(listener)); return wrapped; },
    once(eventName: never, listener: never) { bus.once(eventName, guard(listener)); return wrapped; },
    removeAllListeners(eventName) { bus.removeAllListeners(eventName); return wrapped; },
    finished() { bus.finished(); },
  };
  return wrapped;
}

/**
 * The SDK copies any error raised while it processes events in the background
 * (after a returnImmediately response) into a persisted FAILED task message.
 * Store failures are the only host-supplied source of such errors, so they are
 * logged and replaced by the generic safe message before the SDK sees them.
 */
function sanitizeTaskStore(store: TaskStore): TaskStore {
  return {
    async load(taskId, context) {
      try {
        const raw = await store.load(taskId, context);
        if (!raw) return raw;
        // Detach so host-store objects (accessors, toJSON, shared references) never reach the SDK or serializer.
        const loaded = structuredClone(raw);
        redactSdkFailureText(loaded, context);
        return loaded;
      } catch (error) {
        throw logAndSanitize(context, "a2a.v1.task-store", error);
      }
    },
    async save(task, context) {
      try {
        redactSdkFailureText(task, context);
        return await store.save(task, context);
      } catch (error) {
        throw logAndSanitize(context, "a2a.v1.task-store", error);
      }
    },
    async list(params, context) {
      try {
        return await store.list(params, context);
      } catch (error) {
        throw logAndSanitize(context, "a2a.v1.task-store", error);
      }
    },
  };
}

export function createA2AV1Handler({
  agentCard,
  executor,
  taskStore = new InMemoryTaskStore(dzupOwnerResolver),
  recovery,
}: A2AV1HandlerConfig): A2AV1Handler {
  // M3b: cancel propagation needs the store to hold back the SDK's own CANCELED save; a store that cannot report it is refused.
  if (recovery?.port !== undefined && (taskStore as { cancelHoldBack?: unknown }).cancelHoldBack !== true) {
    throw new Error("A2A v1 cancel propagation requires a task store constructed with the cancel hold-back");
  }
  // The SDK turns executor rejections into FAILED task messages. Sanitize before
  // that conversion so a later GetTask cannot disclose the original exception.
  const safeStore = sanitizeTaskStore(taskStore);
  const safeExecutor: AgentExecutor = {
    async execute(request, bus) {
      try {
        // M3a: the operation row is committed before the executor runs, so a crash after the call always leaves a key to inspect.
        // A refused begin (a message already under recovery) never invokes the executor.
        let began: { operationKey: string } | undefined;
        if (recovery) {
          try {
            began = await recovery.begin(request.context, request.taskId, request.userMessage.messageId);
          } catch (error) {
            if (error instanceof OperationRefusedError) {
              // A claim landed after the retry pre-check. An executor rejection would make the SDK persist a synthetic FAILED over a
              // task whose effect is attached or unproven, so re-publish the stored task unchanged instead; the executor is not invoked.
              const stored = await safeStore.load(request.taskId, request.context);
              if (stored) {
                bus.publish(AgentEvent.task(stored));
                return;
              }
            }
            throw error;
          }
        }
        await executor.execute(copyRequestContext(request, began?.operationKey), sanitizeEventBus(bus, request.context, "a2a.v1.execute"));
      } catch (error) {
        throw logAndSanitize(request.context, "a2a.v1.execute", error);
      }
    },
    async cancelTask(taskId, bus) {
      try {
        await executor.cancelTask(taskId, sanitizeEventBus(bus, undefined, "a2a.v1.cancel", true));
      } catch {
        throw logFixedAndSanitize(undefined, "a2a.v1.cancel");
      }
    },
  };
  const requestHandler = new DzupRequestHandler(
    agentCard,
    safeStore,
    safeExecutor,
    new DefaultExecutionEventBusManager(dzupOwnerResolver),
    undefined,
    undefined,
    undefined,
    undefined,
    { validateInputModes: true }
  );
  requestHandler.recovery = recovery;
  return { handler: new JsonRpcTransportHandler(requestHandler), card: agentCard };
}
