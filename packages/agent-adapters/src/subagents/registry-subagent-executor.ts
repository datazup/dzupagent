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
import type {
  AgentDefinition,
  DzupAgentAgentLoader,
} from "../dzupagent/agent-loader.js";
import { compilePolicyForProvider } from "../policy/policy-compiler.js";
import { PolicyConformanceChecker } from "../policy/policy-conformance.js";
import type { AdapterPolicy } from "../policy/policy-compiler.js";

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
 *
 * Target resolution supports three identities:
 *  - a registered provider adapter (`agentId` is a provider id),
 *  - a `.dzupagent/agents` persona (loaded + compiled for the routed provider),
 *  - an inline definition (`agentId === "inline"`, gated by `allowInline`).
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

/**
 * Persona/inline-definition wiring for the executor. When a `loader` is
 * supplied, an `agentId` that is neither a provider nor a resolved snapshot is
 * looked up as a `.dzupagent/agents` persona. Inline definitions
 * (`agentId === "inline"`) are only honored when `allowInline` is true.
 */
export interface SubagentPersonaOptions {
  loader?: Pick<DzupAgentAgentLoader, "loadAgent" | "compileForProvider">;
  allowInline?: boolean;
}

interface ResolvedSubagentTarget {
  providerId: AdapterProviderId;
  adapter?: ReturnType<ProviderAdapterRegistry["get"]>;
  systemPrompt?: string;
  constraints?: NonNullable<SubagentSpec["definition"]>["constraints"];
}

export class RegistrySubagentExecutor implements SubagentExecutorPort {
  constructor(
    private readonly registry: ProviderAdapterRegistry,
    private readonly limits: SubagentExecutorLimits = {},
    private readonly persona: SubagentPersonaOptions = {}
  ) {}

  async run(
    spec: SubagentSpec,
    ctx: SubagentExecutionContext
  ): Promise<SubagentResult> {
    const target = await this.resolveTarget(spec);
    const adapter =
      target.adapter ??
      this.registry.getHealthy(target.providerId) ??
      this.registry.get(target.providerId);
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
      ...(target.systemPrompt !== undefined
        ? { systemPrompt: target.systemPrompt }
        : {}),
      ...agentInputPolicyFields(target.providerId, target.constraints),
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
                  ...(event.usage.costCents !== undefined
                    ? { costUsd: event.usage.costCents / 100 }
                    : {}),
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
        target.providerId,
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
      this.registry.recordFailure(target.providerId, err);
      throw err;
    }

    this.registry.recordSuccess(target.providerId);
    return usage !== undefined
      ? { output: resultText, provider: target.providerId, usage }
      : { output: resultText, provider: target.providerId };
  }

  private async resolveTarget(
    spec: SubagentSpec
  ): Promise<ResolvedSubagentTarget> {
    if (spec.agentId === "inline") {
      return this.resolveInlineTarget(spec);
    }

    const providerId = resolveRegisteredProviderId(this.registry, spec.agentId);
    if (providerId !== undefined) {
      return {
        providerId,
        ...(spec.instructions !== undefined
          ? { systemPrompt: spec.instructions }
          : {}),
      };
    }

    if (spec.resolvedDefinition !== undefined) {
      return this.resolveDefinitionTarget(spec, spec.resolvedDefinition);
    }

    const agent = await this.persona.loader?.loadAgent(spec.agentId);
    if (agent !== undefined) {
      return this.resolvePersonaTarget(spec, agent);
    }

    throw new ForgeError({
      code: "REGISTRY_AGENT_NOT_FOUND",
      message: `Subagent "${spec.agentId}" was not found as a provider adapter, persona, or inline definition`,
      recoverable: false,
      suggestion:
        'Register the adapter, add a .dzupagent/agents persona, or use agentId "inline" with allowInline enabled.',
    });
  }

  private async resolvePersonaTarget(
    spec: SubagentSpec,
    agent: AgentDefinition
  ): Promise<ResolvedSubagentTarget> {
    const routed = this.resolveProviderForDefinition(
      promptFromInput(spec.input),
      agent.preferredProvider,
      agent.personaPrompt,
      agent.skillNames
    );
    const compiled = await this.persona.loader!.compileForProvider(
      agent,
      routed.providerId
    );
    return {
      ...routed,
      ...withSystemPrompt(joinPrompt(compiled, spec.instructions)),
      ...(agent.constraints !== undefined
        ? { constraints: agent.constraints }
        : {}),
    };
  }

  private async resolveInlineTarget(
    spec: SubagentSpec
  ): Promise<ResolvedSubagentTarget> {
    if (this.persona.allowInline !== true) {
      throw new ForgeError({
        code: "REGISTRY_INVALID_INPUT",
        message: "Inline subagent definitions are disabled",
        recoverable: false,
        suggestion:
          "Pass allowInline: true when constructing RegistrySubagentExecutor.",
      });
    }
    if (spec.definition === undefined) {
      throw new ForgeError({
        code: "REGISTRY_INVALID_INPUT",
        message: "Inline subagent definition is required",
        recoverable: false,
      });
    }

    return this.resolveDefinitionTarget(spec, spec.definition);
  }

  private async resolveDefinitionTarget(
    spec: SubagentSpec,
    definition: NonNullable<SubagentSpec["definition"]>
  ): Promise<ResolvedSubagentTarget> {
    const routed = this.resolveProviderForDefinition(
      promptFromInput(spec.input),
      definition.preferredProvider as AdapterProviderId | undefined,
      definition.personaPrompt,
      definition.skillNames ?? []
    );
    const compiled =
      this.persona.loader !== undefined && spec.resolvedDefinition === undefined
        ? await this.persona.loader.compileForProvider(
            inlineDefinitionToAgentDefinition(definition),
            routed.providerId
          )
        : definition.personaPrompt;
    return {
      ...routed,
      ...withSystemPrompt(joinPrompt(compiled, spec.instructions)),
      ...(definition.constraints !== undefined
        ? { constraints: definition.constraints }
        : {}),
    };
  }

  private resolveProviderForDefinition(
    prompt: string,
    preferredProvider: AdapterProviderId | undefined,
    systemPrompt: string,
    skillNames: string[]
  ): ResolvedSubagentTarget {
    if (
      preferredProvider !== undefined &&
      resolveRegisteredProviderId(this.registry, preferredProvider) !==
        undefined
    ) {
      const adapter =
        this.registry.getHealthy(preferredProvider) ??
        this.registry.get(preferredProvider);
      if (adapter !== undefined) {
        return { providerId: preferredProvider, adapter };
      }
    }

    const routed = this.registry.getForTask({
      prompt,
      tags: [],
      ...(preferredProvider !== undefined ? { preferredProvider } : {}),
      systemPrompt,
      skillIds: skillNames,
    });
    return {
      providerId: routed.decision.provider as AdapterProviderId,
      adapter: routed.adapter,
    };
  }
}

function promptFromInput(input: SubagentSpec["input"]): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

function withSystemPrompt(prompt: string | undefined): {
  systemPrompt?: string;
} {
  return prompt !== undefined ? { systemPrompt: prompt } : {};
}

function joinPrompt(
  base: string | undefined,
  instructions: string | undefined
): string | undefined {
  const parts = [base, instructions].filter(
    (part): part is string => typeof part === "string" && part.length > 0
  );
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

function inlineDefinitionToAgentDefinition(
  definition: NonNullable<SubagentSpec["definition"]>
): AgentDefinition {
  // `estimatedCostUsd` is a subagents-only budget hint, not part of the adapter
  // skill-bundle constraint shape — strip it for the loader's AgentDefinition.
  const { estimatedCostUsd: _estimatedCostUsd, ...constraints } =
    definition.constraints ?? {};
  return {
    name: definition.name,
    description: "",
    version: 1,
    ...(definition.preferredProvider !== undefined
      ? { preferredProvider: definition.preferredProvider as AdapterProviderId }
      : {}),
    skillNames: definition.skillNames ?? [],
    memoryScope: "project",
    constraints,
    personaPrompt: definition.personaPrompt,
    filePath: "<inline>",
  };
}

function agentInputPolicyFields(
  providerId: AdapterProviderId,
  constraints:
    | NonNullable<SubagentSpec["definition"]>["constraints"]
    | undefined
): Partial<AgentInput> {
  if (constraints === undefined) return {};
  const activePolicy: AdapterPolicy = {
    ...(constraints.maxBudgetUsd !== undefined
      ? { maxBudgetUsd: constraints.maxBudgetUsd }
      : {}),
    ...(constraints.approvalMode === "required"
      ? { approvalRequired: true }
      : {}),
    ...(constraints.networkPolicy !== undefined
      ? { networkAccess: constraints.networkPolicy !== "off" }
      : {}),
    ...(constraints.toolPolicy !== undefined
      ? { toolPolicy: constraints.toolPolicy }
      : {}),
  };
  const compiled = compilePolicyForProvider(providerId, activePolicy);
  const conformance = new PolicyConformanceChecker().check(
    providerId,
    activePolicy,
    compiled
  );
  const conformanceWarnings = [
    ...conformance.violations
      .filter((violation) => violation.severity === "warning")
      .map((violation) => `${violation.field}: ${violation.reason}`),
    ...conformance.warnings,
  ];

  return {
    ...(constraints.maxBudgetUsd !== undefined
      ? { maxBudgetUsd: constraints.maxBudgetUsd }
      : {}),
    ...(Object.keys(compiled.inputOptions).length > 0 ||
    constraints.toolPolicy !== undefined ||
    constraints.networkPolicy !== undefined
      ? {
          options: {
            ...compiled.inputOptions,
            ...(constraints.networkPolicy !== undefined
              ? { networkPolicy: constraints.networkPolicy }
              : {}),
            ...(constraints.toolPolicy !== undefined
              ? { toolPolicy: constraints.toolPolicy }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(activePolicy).length > 0
      ? {
          policyContext: {
            activePolicy,
            ...(Object.keys(compiled.guardrails).length > 0
              ? { projectedGuardrails: compiled.guardrails }
              : {}),
            ...(conformanceWarnings.length > 0 ? { conformanceWarnings } : {}),
          },
        }
      : {}),
  };
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
