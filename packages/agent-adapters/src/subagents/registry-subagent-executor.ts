import type { AgentInput } from "@dzupagent/adapter-types";
import type { AdapterProviderId } from "../types.js";
import type {
  SubagentExecutorPort,
  SubagentExecutionContext,
  SubagentResult,
  SubagentSpec,
} from "@dzupagent/subagents";
import { ForgeError } from "@dzupagent/core/events";
import type { ProviderAdapterRegistry } from "../registry/adapter-registry.js";

/**
 * Implements `@dzupagent/subagents`'s {@link SubagentExecutorPort} by dispatching
 * a {@link SubagentSpec} to a real provider adapter via the
 * {@link ProviderAdapterRegistry}. This is the wiring point that turns the
 * (otherwise inert) background-subagent runtime into a functional one: the
 * subagents package never imports the agent runtime (layer DAG), so this layer-4
 * adapter supplies it through the port.
 *
 * Cancellation and resumption are first-class: the spec's run signal is passed
 * straight to the adapter via `AgentInput.signal`, and progress events from the
 * adapter stream are forwarded to the runtime's `onProgress`.
 */
/**
 * Per-run ceilings enforced by the executor while consuming an adapter stream.
 * These bound a single subagent run so a runaway child cannot consume unbounded
 * wall-clock (AGENT-L-11) or tokens (AGENT-M-05). All fields are optional; an
 * unset field means "no ceiling for that dimension".
 */
export interface SubagentExecutorLimits {
  /** Abort the run if it has not completed within this many milliseconds. */
  timeoutMs?: number;
  /** Abort the run once reported cumulative output tokens exceed this ceiling. */
  maxOutputTokens?: number;
}

export class RegistrySubagentExecutor implements SubagentExecutorPort {
  constructor(
    private readonly registry: ProviderAdapterRegistry,
    private readonly limits: SubagentExecutorLimits = {}
  ) {}

  async run(
    spec: SubagentSpec,
    ctx: SubagentExecutionContext
  ): Promise<SubagentResult> {
    const providerId = resolveRegisteredProviderId(this.registry, spec.agentId);
    if (!providerId) {
      throw new ForgeError({
        code: "REGISTRY_AGENT_NOT_FOUND",
        message: `Subagent provider "${spec.agentId}" is not registered or is unavailable`,
        recoverable: false,
        suggestion: "Register the adapter before spawning a subagent for it.",
      });
    }

    const adapter =
      this.registry.getHealthy(providerId) ?? this.registry.get(providerId);
    if (!adapter) {
      throw new ForgeError({
        code: "REGISTRY_AGENT_NOT_FOUND",
        message: `Subagent provider "${spec.agentId}" is not registered or is unavailable`,
        recoverable: false,
        suggestion: "Register the adapter before spawning a subagent for it.",
      });
    }

    // AGENT-L-11: derive a run-scoped signal that aborts on the caller's signal
    // OR a per-run timeout, so a stalled adapter stream cannot run forever.
    const { signal, dispose } = withTimeout(ctx.signal, this.limits.timeoutMs);

    const input: AgentInput = {
      prompt:
        typeof spec.input === "string"
          ? spec.input
          : JSON.stringify(spec.input),
      signal,
      ...(spec.instructions !== undefined
        ? { systemPrompt: spec.instructions }
        : {}),
    };

    let resultText = "";
    let usage: SubagentResult["usage"];
    let failureError: string | undefined;
    let streamedOutputTokens = 0;

    try {
      for await (const event of adapter.execute(input)) {
        if (signal.aborted) {
          throw abortReason(ctx.signal, this.limits.timeoutMs);
        }
        switch (event.type) {
          case "adapter:message":
            ctx.onProgress?.(event.content.slice(0, 200));
            break;
          case "adapter:progress":
            ctx.onProgress?.((event.message ?? event.phase).slice(0, 200));
            break;
          case "adapter:completed":
            resultText = event.result;
            usage = event.usage
              ? {
                  inputTokens: event.usage.inputTokens,
                  outputTokens: event.usage.outputTokens,
                }
              : undefined;
            // AGENT-M-05: enforce the output-token ceiling on reported usage.
            if (typeof event.usage?.outputTokens === "number") {
              streamedOutputTokens = event.usage.outputTokens;
            }
            break;
          case "adapter:failed":
            if (!resultText) {
              failureError = event.error ?? "subagent_adapter_failed";
            }
            break;
          default:
            break;
        }

        if (
          this.limits.maxOutputTokens !== undefined &&
          streamedOutputTokens > this.limits.maxOutputTokens
        ) {
          throw new ForgeError({
            code: "TOKEN_LIMIT_EXCEEDED",
            message: `Subagent exceeded its output-token budget (${streamedOutputTokens} > ${this.limits.maxOutputTokens})`,
            recoverable: false,
            suggestion:
              "Raise maxOutputTokens for this executor or constrain the subagent task.",
          });
        }
      }
    } catch (error) {
      this.registry.recordFailure(
        providerId,
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    } finally {
      dispose();
    }

    if (failureError !== undefined && !resultText) {
      const err = new ForgeError({
        code: "ADAPTER_EXECUTION_FAILED",
        message: failureError,
        recoverable: true,
      });
      this.registry.recordFailure(providerId, err);
      throw err;
    }

    this.registry.recordSuccess(providerId);
    return usage !== undefined
      ? { output: resultText, provider: providerId, usage }
      : { output: resultText, provider: providerId };
  }
}

/**
 * Combine the caller's abort signal with an optional per-run timeout into a
 * single signal. Returns a `dispose` that clears the timer and detaches the
 * listener so neither holds the event loop open.
 */
function withTimeout(
  parent: AbortSignal,
  timeoutMs: number | undefined
): { signal: AbortSignal; dispose: () => void } {
  if (timeoutMs === undefined) {
    return { signal: parent, dispose: () => {} };
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Never let the timeout timer keep the process alive.
  (timer as { unref?: () => void }).unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * Build the typed error thrown when the run signal aborts, distinguishing a
 * caller-initiated cancellation from a per-run timeout (AGENT-L-11).
 */
function abortReason(
  callerSignal: AbortSignal,
  timeoutMs: number | undefined
): ForgeError {
  if (callerSignal.aborted) {
    return new ForgeError({
      code: "AGENT_ABORTED",
      message: "Subagent run was aborted",
      recoverable: false,
    });
  }
  return new ForgeError({
    code: "ADAPTER_TIMEOUT",
    message:
      timeoutMs !== undefined
        ? `Subagent run exceeded its ${timeoutMs}ms timeout`
        : "Subagent run timed out",
    recoverable: false,
  });
}

function resolveRegisteredProviderId(
  registry: ProviderAdapterRegistry,
  agentId: string
): AdapterProviderId | undefined {
  return registry.listAdapters().find((providerId) => providerId === agentId);
}
