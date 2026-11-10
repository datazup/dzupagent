import { TaskState } from "@a2a-js/sdk";
import type { AgentCard, CancelTaskRequest, Task } from "@a2a-js/sdk";
import { JsonRpcTaskNotCancelableError } from "@a2a-js/sdk/errors";
import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";
import type { AgentExecutor, ExecutionEventBus, ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import type { Context } from "hono";
import { logRouteError } from "../../routes/route-error.js";
import { dzupOwnerResolver } from "./identity.js";

export type { AgentExecutor, TaskStore } from "@a2a-js/sdk/server";

export interface A2AV1Config {
  executor: AgentExecutor;
  taskStore?: TaskStore;
}

export interface A2AV1HandlerConfig extends A2AV1Config {
  agentCard: AgentCard;
}

export interface A2AV1Handler {
  handler: JsonRpcTransportHandler;
  card: AgentCard;
}

class DzupRequestHandler extends DefaultRequestHandler {
  override async cancelTask(params: CancelTaskRequest, context: ServerCallContext) {
    // The SDK makes repeat cancellation idempotent. M1 requires -32002 for
    // every terminal task, including one already canceled. getTask preserves
    // the SDK's owner/tenant check and not-found response before this check.
    const task = await this.getTask({ id: params.id, tenant: "" }, context);
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
      throw new JsonRpcTaskNotCancelableError();
    }
    return super.cancelTask(params, context);
  }
}

function logAndSanitize(context: ServerCallContext | undefined, label: string, error: unknown): Error {
  const route = context?.state.get("dzup.a2a.route") as Context | undefined;
  const requestInfo = route ?? { req: { method: "POST", path: "/a2a" } as Context["req"] };
  const { safe } = logRouteError(requestInfo, label, error);
  return new Error(safe);
}

const SDK_FAILURE_PREFIX = "Event processing loop failed:";

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
      if (content?.$case === "text" && content.value.startsWith(SDK_FAILURE_PREFIX)) {
        const error = logAndSanitize(context, "a2a.v1.persisted-failure", new Error(content.value));
        content.value = `${SDK_FAILURE_PREFIX} ${error.message}`;
      }
    }
  }
}

/**
 * Events are detached (structured-cloned) at the bus boundary so a hostile
 * getter or unclonable value fails here, inside the executor call, where the
 * failure is logged and replaced by the generic message, not later inside the
 * SDK's background loop.
 */
function sanitizeEventBus(bus: ExecutionEventBus, context: ServerCallContext | undefined, label: string): ExecutionEventBus {
  const wrapped: ExecutionEventBus = {
    publish(event) {
      let detached = event;
      try {
        if (typeof event === "object" && event !== null && "data" in event) {
          detached = { ...event, data: structuredClone((event as { data: unknown }).data) } as typeof event;
        }
      } catch (error) {
        throw logAndSanitize(context, label, error);
      }
      bus.publish(detached);
    },
    on(eventName: never, listener: never) { bus.on(eventName, listener); return wrapped; },
    off(eventName: never, listener: never) { bus.off(eventName, listener); return wrapped; },
    once(eventName: never, listener: never) { bus.once(eventName, listener); return wrapped; },
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
        return await store.load(taskId, context);
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
}: A2AV1HandlerConfig): A2AV1Handler {
  // The SDK turns executor rejections into FAILED task messages. Sanitize before
  // that conversion so a later GetTask cannot disclose the original exception.
  const safeExecutor: AgentExecutor = {
    async execute(request, bus) {
      try {
        await executor.execute(request, sanitizeEventBus(bus, request.context, "a2a.v1.execute"));
      } catch (error) {
        throw logAndSanitize(request.context, "a2a.v1.execute", error);
      }
    },
    async cancelTask(taskId, bus) {
      try {
        await executor.cancelTask(taskId, sanitizeEventBus(bus, undefined, "a2a.v1.cancel"));
      } catch (error) {
        throw logAndSanitize(undefined, "a2a.v1.cancel", error);
      }
    },
  };
  const requestHandler = new DzupRequestHandler(
    agentCard,
    sanitizeTaskStore(taskStore),
    safeExecutor,
    new DefaultExecutionEventBusManager(dzupOwnerResolver),
    undefined,
    undefined,
    undefined,
    undefined,
    { validateInputModes: true }
  );
  return { handler: new JsonRpcTransportHandler(requestHandler), card: agentCard };
}
