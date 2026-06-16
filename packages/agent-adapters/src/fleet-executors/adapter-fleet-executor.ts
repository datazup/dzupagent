import type {
  Executor,
  WorkerEvent,
  WorkerHandle,
  WorkerInbound,
  WorkerOutcome,
  WorkerSpec,
} from "@dzupagent/agent-types/fleet";
import type { AgentEvent, AdapterProviderId } from "@dzupagent/adapter-types";
import type { ProviderAdapterRegistry } from "../registry/adapter-registry.js";
import { mapWorkerSpecToAgentExecution } from "./adapter-fleet-mapper.js";

export interface AdapterFleetExecutorOptions {
  registry: ProviderAdapterRegistry;
}

export class AdapterFleetExecutor implements Executor {
  readonly id = "adapter";

  constructor(private readonly options: AdapterFleetExecutorOptions) {}

  async spawn(spec: WorkerSpec): Promise<WorkerHandle> {
    const { input, task } = mapWorkerSpecToAgentExecution(spec);
    const abortController = new AbortController();
    let activeProviderId: AdapterProviderId | undefined;
    let cancelled = false;
    let cancelReason: string | null = null;

    const buffer: WorkerEvent[] = [];
    const waiters: Array<() => void> = [];
    let closed = false;
    let terminalOutcome: WorkerOutcome | undefined;
    let sawExitEvent = false;

    const push = (event: WorkerEvent): void => {
      if (closed) return;
      if (event.kind === "exit") sawExitEvent = true;
      buffer.push(event);
      waiters.splice(0).forEach((fn) => fn());
    };

    const close = (): void => {
      if (closed) return;
      closed = true;
      waiters.splice(0).forEach((fn) => fn());
    };

    const finish = (outcome: WorkerOutcome): WorkerOutcome => {
      terminalOutcome = outcome;
      if (!sawExitEvent) {
        push({
          kind: "exit",
          code: outcome.exitCode,
          reason: outcome.reason ?? null,
          at: new Date().toISOString(),
        });
      }
      close();
      return outcome;
    };

    const interruptActiveAdapter = (): void => {
      if (!activeProviderId) return;
      this.options.registry.get(activeProviderId)?.interrupt();
    };

    const producer = (async (): Promise<WorkerOutcome> => {
      try {
        for await (const adapterEvent of this.options.registry.executeWithFallback(
          { ...input, signal: abortController.signal },
          task
        )) {
          const workerEvent = mapAdapterEventToWorkerEvent(adapterEvent);
          if (hasProviderId(adapterEvent)) activeProviderId = adapterEvent.providerId;
          if (workerEvent) push(workerEvent);
          if (adapterEvent.type === "adapter:completed") {
            return finish({ state: "completed", exitCode: 0 });
          }
          if (adapterEvent.type === "adapter:failed") {
            terminalOutcome = {
              state: "failed",
              exitCode: 1,
              reason: adapterEvent.error,
            };
          }
        }

        if (cancelled) {
          return finish({
            state: "cancelled",
            exitCode: null,
            reason: cancelReason ?? "cancelled",
          });
        }
        return finish(terminalOutcome ?? { state: "completed", exitCode: 0 });
      } catch (err) {
        if (cancelled) {
          return finish({
            state: "cancelled",
            exitCode: null,
            reason: cancelReason ?? "cancelled",
          });
        }

        const message = err instanceof Error ? err.message : String(err);
        if (terminalOutcome === undefined) {
          push({
            kind: "error",
            message,
            fatal: true,
            at: new Date().toISOString(),
          });
        }
        return finish(terminalOutcome ?? { state: "failed", exitCode: 1, reason: message });
      }
    })();

    const cancelFn = async (reason: string): Promise<void> => {
      if (cancelled) return;
      cancelled = true;
      cancelReason = reason;
      abortController.abort();
      interruptActiveAdapter();
    };

    const events: AsyncIterable<WorkerEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<WorkerEvent>> {
            while (buffer.length === 0 && !closed) {
              await new Promise<void>((resolve) => waiters.push(resolve));
            }
            if (buffer.length > 0) return { value: buffer.shift()!, done: false };
            return { value: undefined as never, done: true };
          },
        };
      },
    };

    return {
      workerId: spec.workerId,
      events,
      async send(msg: WorkerInbound) {
        if (msg.kind === "cancel") return cancelFn(msg.reason);
        throw new Error(
          `AdapterFleetExecutor does not support WorkerInbound kind "${msg.kind}"`
        );
      },
      cancel: cancelFn,
      async wait() {
        return producer;
      },
    };
  }
}

function mapAdapterEventToWorkerEvent(event: AgentEvent): WorkerEvent | undefined {
  const at = new Date(event.timestamp).toISOString();
  switch (event.type) {
    case "adapter:started":
      return { kind: "step_start", stepId: event.sessionId, at };
    case "adapter:message":
      return {
        kind: "message",
        text: event.content,
        role: event.role === "assistant" ? "assistant" : "tool",
        at,
      };
    case "adapter:tool_call":
      return {
        kind: "tool_call",
        toolName: event.toolName,
        inputSummary: summarizeInput(event.input),
        at,
      };
    case "adapter:completed":
      return { kind: "step_done", stepId: event.sessionId, at };
    case "adapter:failed":
      return { kind: "error", message: event.error, fatal: true, at };
    default:
      return undefined;
  }
}

function summarizeInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function hasProviderId(event: AgentEvent): event is AgentEvent & { providerId: AdapterProviderId } {
  return "providerId" in event;
}
