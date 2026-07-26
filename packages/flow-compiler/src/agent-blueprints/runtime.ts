import {
  validateCompiledAgentDescriptor,
  type AgentHandlerEffectClass,
  type AgentJsonValue,
  type CompiledAgentDescriptor,
} from "@dzupagent/runtime-contracts/agent-blueprint";

import type {
  InMemoryAgentHandlerRegistry,
} from "./handler-registry.js";
import {
  verifyCompiledAgentDescriptorFingerprint,
} from "./compiler.js";

export interface AgentBlueprintHandlerContext {
  readonly descriptor: CompiledAgentDescriptor;
  readonly input: unknown;
  readonly output?: unknown;
  readonly evidence?: readonly AgentBlueprintEvidenceResult[];
}

export interface AgentBlueprintProviderRequest {
  readonly descriptor: CompiledAgentDescriptor;
  readonly renderedPrompt: unknown;
  readonly input: unknown;
  readonly tools: readonly string[];
  readonly policy: Readonly<Record<string, AgentJsonValue>>;
}

export interface AgentBlueprintProviderTerminalReceipt {
  readonly eventType: "completed" | "failed";
  readonly attemptId: string;
  readonly providerId: string;
  readonly usage:
    | {
        readonly kind: "measured";
        readonly inputTokens: number;
        readonly outputTokens: number;
      }
    | {
        readonly kind: "unknown";
        readonly reason: string;
      };
}

export interface AgentBlueprintProviderResponse {
  readonly status: "completed" | "failed";
  readonly output?: unknown;
  readonly terminalReason?: string;
  readonly terminalReceipt?: AgentBlueprintProviderTerminalReceipt;
}

export type AgentBlueprintProviderInvoker = (
  request: AgentBlueprintProviderRequest,
) => Promise<AgentBlueprintProviderResponse>;

export interface AgentBlueprintValidatorResult {
  readonly valid: boolean;
  readonly diagnostics?: readonly string[];
}

export interface AgentBlueprintEvidenceResult {
  readonly handlerRef: string;
  readonly value: unknown;
}

export interface ExecuteCompiledAgentBlueprintInput {
  readonly descriptor: CompiledAgentDescriptor;
  readonly handlers: InMemoryAgentHandlerRegistry;
  readonly input: unknown;
  readonly invokeProvider: AgentBlueprintProviderInvoker;
  /**
   * Handler effects are host policy, never blueprint authority. The default
   * permits pure and read-only utilities; writes and external calls must be
   * granted explicitly by the host.
   */
  readonly allowedHandlerEffectClasses?: readonly AgentHandlerEffectClass[];
}

export interface ExecuteCompiledAgentBlueprintResult {
  readonly descriptorFingerprint: `sha256:${string}`;
  readonly renderedPrompt: unknown;
  readonly rawOutput: unknown;
  readonly normalizedOutput: unknown;
  readonly output: unknown;
  readonly validatorResults: readonly AgentBlueprintValidatorResult[];
  readonly evidence: readonly AgentBlueprintEvidenceResult[];
  readonly authorityEffect: CompiledAgentDescriptor["authorityEffect"];
}

export class AgentBlueprintExecutionError extends Error {
  constructor(
    readonly code:
      | "DESCRIPTOR_INVALID"
      | "DESCRIPTOR_FINGERPRINT_MISMATCH"
      | "PROVIDER_RESULT_INVALID"
      | "PROVIDER_TERMINAL_RECEIPT_MISSING"
      | "PROVIDER_FAILED"
      | "OUTPUT_INVALID"
      | "EVIDENCE_INVALID",
    message: string,
    readonly diagnostics: readonly string[] = [],
  ) {
    super(`${code}: ${message}`);
    this.name = "AgentBlueprintExecutionError";
  }
}

/**
 * Executes the generic blueprint stages around a host-provided provider call.
 * The provider and handlers can return flexible values, but only host-owned
 * registered functions run. A host-action-request is returned as evidence and
 * is never executed by this pipeline.
 */
export async function executeCompiledAgentBlueprint(
  request: ExecuteCompiledAgentBlueprintInput,
): Promise<ExecuteCompiledAgentBlueprintResult> {
  const shape = validateCompiledAgentDescriptor(request.descriptor);
  if (!shape.valid) {
    throw new AgentBlueprintExecutionError(
      "DESCRIPTOR_INVALID",
      "Compiled agent descriptor failed structural validation.",
      shape.diagnostics.map(
        (diagnostic) =>
          `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
      ),
    );
  }
  if (!verifyCompiledAgentDescriptorFingerprint(request.descriptor)) {
    throw new AgentBlueprintExecutionError(
      "DESCRIPTOR_FINGERPRINT_MISMATCH",
      "Compiled agent descriptor fingerprint does not match its content.",
    );
  }

  const allowedEffects =
    request.allowedHandlerEffectClasses ?? ["none", "read"];
  const baseContext: AgentBlueprintHandlerContext = {
    descriptor: request.descriptor,
    input: request.input,
  };
  const renderedPrompt = await request.handlers.invoke(
    request.descriptor.handlers.renderer.ref,
    "renderer",
    baseContext,
    { allowedEffectClasses: allowedEffects },
  );
  const providerResponse = await request.invokeProvider({
    descriptor: request.descriptor,
    renderedPrompt,
    input: request.input,
    tools: request.descriptor.tools,
    policy: request.descriptor.policy,
  });
  validateProviderResponse(providerResponse);
  const rawOutput = providerResponse.output;
  const normalizedOutput = request.descriptor.handlers.normalizer
    ? await request.handlers.invoke(
        request.descriptor.handlers.normalizer.ref,
        "normalizer",
        {
          ...baseContext,
          output: rawOutput,
        } satisfies AgentBlueprintHandlerContext,
        { allowedEffectClasses: allowedEffects },
      )
    : rawOutput;

  const validatorResults: AgentBlueprintValidatorResult[] = [];
  for (const validator of request.descriptor.handlers.validators) {
    const value = await request.handlers.invoke(
      validator.ref,
      "validator",
      {
        ...baseContext,
        output: normalizedOutput,
      } satisfies AgentBlueprintHandlerContext,
      { allowedEffectClasses: allowedEffects },
    );
    validatorResults.push(normalizeValidatorResult(value));
  }
  const failedDiagnostics = validatorResults.flatMap((result) =>
    result.valid ? [] : [...(result.diagnostics ?? ["Output was rejected."])],
  );
  if (failedDiagnostics.length > 0) {
    throw new AgentBlueprintExecutionError(
      "OUTPUT_INVALID",
      "Compiled agent output did not pass its host validators.",
      failedDiagnostics,
    );
  }

  const evidence: AgentBlueprintEvidenceResult[] = [];
  for (const resolver of request.descriptor.handlers.evidenceResolvers) {
    evidence.push({
      handlerRef: resolver.ref,
      value: await request.handlers.invoke(
        resolver.ref,
        "evidence-resolver",
        {
          ...baseContext,
          output: normalizedOutput,
        } satisfies AgentBlueprintHandlerContext,
        { allowedEffectClasses: allowedEffects },
      ),
    });
  }
  const invalidEvidence = evidence.flatMap(({ handlerRef, value }) => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { valid?: unknown }).valid === false
    ) {
      const missing = (value as { missing?: unknown }).missing;
      return [
        `${handlerRef}: missing ${
          Array.isArray(missing) ? missing.join(", ") : "required evidence"
        }`,
      ];
    }
    return [];
  });
  if (invalidEvidence.length > 0) {
    throw new AgentBlueprintExecutionError(
      "EVIDENCE_INVALID",
      "Compiled agent output is missing required evidence.",
      invalidEvidence,
    );
  }

  let output = normalizedOutput;
  for (const postprocessor of request.descriptor.handlers.postprocessors) {
    output = await request.handlers.invoke(
      postprocessor.ref,
      "postprocessor",
      {
        ...baseContext,
        output,
        evidence,
      } satisfies AgentBlueprintHandlerContext,
      { allowedEffectClasses: allowedEffects },
    );
  }

  return {
    descriptorFingerprint: request.descriptor.fingerprint,
    renderedPrompt,
    rawOutput,
    normalizedOutput,
    output,
    validatorResults,
    evidence,
    authorityEffect: request.descriptor.authorityEffect,
  };
}

function validateProviderResponse(
  response: AgentBlueprintProviderResponse,
): void {
  if (
    !response ||
    typeof response !== "object" ||
    !["completed", "failed"].includes(response.status)
  ) {
    throw new AgentBlueprintExecutionError(
      "PROVIDER_RESULT_INVALID",
      "Provider must return a typed completed or failed response.",
    );
  }
  const receipt = response.terminalReceipt;
  if (
    !receipt ||
    receipt.eventType !== response.status ||
    typeof receipt.attemptId !== "string" ||
    receipt.attemptId.length === 0 ||
    typeof receipt.providerId !== "string" ||
    receipt.providerId.length === 0 ||
    !validProviderUsage(receipt.usage, response.status)
  ) {
    throw new AgentBlueprintExecutionError(
      "PROVIDER_TERMINAL_RECEIPT_MISSING",
      "Provider response requires a matching terminal receipt with identity and usage.",
    );
  }
  if (response.status === "failed") {
    throw new AgentBlueprintExecutionError(
      "PROVIDER_FAILED",
      response.terminalReason?.trim() || "Provider reported failure.",
    );
  }
  if (response.output === undefined) {
    throw new AgentBlueprintExecutionError(
      "PROVIDER_RESULT_INVALID",
      "Completed provider response requires output.",
    );
  }
}

function validProviderUsage(
  usage: AgentBlueprintProviderTerminalReceipt["usage"] | undefined,
  status: AgentBlueprintProviderResponse["status"],
): boolean {
  if (usage?.kind === "measured") {
    return (
      Number.isFinite(usage.inputTokens) &&
      usage.inputTokens >= 0 &&
      Number.isFinite(usage.outputTokens) &&
      usage.outputTokens >= 0
    );
  }
  return (
    status === "failed" &&
    usage?.kind === "unknown" &&
    typeof usage.reason === "string" &&
    usage.reason.trim().length > 0
  );
}

function normalizeValidatorResult(
  value: unknown,
): AgentBlueprintValidatorResult {
  if (value === true) return { valid: true };
  if (value === false) return { valid: false };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as {
      valid?: unknown;
      diagnostics?: unknown;
    };
    if (typeof candidate.valid === "boolean") {
      return {
        valid: candidate.valid,
        ...(Array.isArray(candidate.diagnostics)
          ? {
              diagnostics: candidate.diagnostics.filter(
                (diagnostic): diagnostic is string =>
                  typeof diagnostic === "string",
              ),
            }
          : {}),
      };
    }
  }
  return {
    valid: false,
    diagnostics: ["Validator returned an unsupported result shape."],
  };
}
