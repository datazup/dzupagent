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
export class RegistrySubagentExecutor implements SubagentExecutorPort {
  constructor(private readonly registry: ProviderAdapterRegistry) {}

  async run(
    spec: SubagentSpec,
    ctx: SubagentExecutionContext,
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

    const input: AgentInput = {
      prompt:
        typeof spec.input === "string"
          ? spec.input
          : JSON.stringify(spec.input),
      signal: ctx.signal,
      ...(spec.instructions !== undefined
        ? { systemPrompt: spec.instructions }
        : {}),
    };

    let resultText = "";
    let usage: SubagentResult["usage"];
    let failureError: string | undefined;

    try {
      for await (const event of adapter.execute(input)) {
        if (ctx.signal.aborted) {
          throw new Error("aborted");
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
            break;
          case "adapter:failed":
            if (!resultText) {
              failureError = event.error ?? "subagent_adapter_failed";
            }
            break;
          default:
            break;
        }
      }
    } catch (error) {
      this.registry.recordFailure(
        providerId,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }

    if (failureError !== undefined && !resultText) {
      this.registry.recordFailure(providerId, new Error(failureError));
      throw new Error(failureError);
    }

    this.registry.recordSuccess(providerId);
    return usage !== undefined
      ? { output: resultText, usage }
      : { output: resultText };
  }
}

function resolveRegisteredProviderId(
  registry: ProviderAdapterRegistry,
  agentId: string,
): AdapterProviderId | undefined {
  return registry.listAdapters().find((providerId) => providerId === agentId);
}
