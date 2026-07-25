import { describe, expect, it, vi } from "vitest";

import {
  AGENT_BLUEPRINT_SCHEMA,
  type AgentBlueprint,
} from "@dzupagent/runtime-contracts/agent-blueprint";

import {
  AgentBlueprintCompileError,
  AgentHandlerRegistryError,
  CompiledAgentRuntime,
  CompiledAgentRuntimeError,
  InMemoryAgentHandlerRegistry,
  compileAgentBlueprint,
  executeCompiledAgentBlueprint,
  type AgentBlueprintCatalog,
  type AgentBlueprintExecutionError,
} from "../agent-blueprints.js";

const blueprint: AgentBlueprint = {
  schema: AGENT_BLUEPRINT_SCHEMA,
  id: "reviewer",
  version: 1,
  status: "published",
  personaRef: "persona.reviewer/v1",
  taskRef: "task.review/v1",
  promptOverlayRefs: ["prompt.strict-output/v1"],
  inputSchemaRef: "schema.input/v1",
  outputSchemaRef: "schema.output/v1",
  toolsetRef: "toolset.readonly/v1",
  policyRef: "policy.readonly/v1",
  handlers: {
    renderer: "prompt.render/v1",
    normalizer: "decision.normalize/v1",
    validators: ["output.validate/v1"],
  },
  evidenceKinds: ["validation"],
  authorityEffect: "advisory",
};

const catalog: AgentBlueprintCatalog = {
  personas: [
    {
      ref: "persona.reviewer/v1",
      status: "published",
      summary: "Independent reviewer",
      promptRef: "prompt.persona.reviewer/v1",
      compatibleTaskRefs: ["task.review/v1"],
    },
  ],
  tasks: [
    {
      ref: "task.review/v1",
      status: "published",
      summary: "Review candidate",
      promptRef: "prompt.task.review/v1",
    },
  ],
  prompts: [
    {
      ref: "prompt.persona.reviewer/v1",
      status: "published",
      content: "Be independent.",
    },
    {
      ref: "prompt.task.review/v1",
      status: "published",
      content: "Review evidence.",
    },
    {
      ref: "prompt.strict-output/v1",
      status: "published",
      content: "Return the contract.",
    },
  ],
  policies: [
    {
      ref: "policy.readonly/v1",
      status: "published",
      value: { readOnly: true },
    },
  ],
  toolsets: [
    {
      ref: "toolset.readonly/v1",
      status: "published",
      tools: ["repo.read", "repo.read"],
    },
  ],
  schemas: [
    { ref: "schema.input/v1", status: "published", schema: { type: "object" } },
    { ref: "schema.output/v1", status: "published", schema: { type: "object" } },
  ],
  handlers: [
    {
      ref: "prompt.render/v1",
      status: "published",
      kind: "renderer",
      version: 1,
      effectClass: "none",
      deterministic: true,
    },
    {
      ref: "decision.normalize/v1",
      status: "published",
      kind: "normalizer",
      version: 1,
      effectClass: "none",
      deterministic: true,
    },
    {
      ref: "output.validate/v1",
      status: "published",
      kind: "validator",
      version: 1,
      effectClass: "none",
      deterministic: true,
    },
  ],
};

describe("agent blueprint compiler", () => {
  it("strictly resolves, fingerprints, freezes, and orders prompt layers", () => {
    const first = compileAgentBlueprint(blueprint, catalog);
    const second = compileAgentBlueprint(blueprint, catalog);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.promptLayers.map(({ kind }) => kind)).toEqual([
      "persona",
      "task",
      "blueprint-overlay",
    ]);
    expect(
      first.promptLayers.every(({ contentSha256 }) =>
        /^sha256:[a-f0-9]{64}$/.test(contentSha256),
      ),
    ).toBe(true);
    expect(first.promptLayers[0]?.contentSha256).not.toBe(
      first.promptLayers[1]?.contentSha256,
    );
    expect(first.tools).toEqual(["repo.read"]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("fails closed for unknown or unpublished references", () => {
    expect(() =>
      compileAgentBlueprint(
        { ...blueprint, policyRef: "policy.missing/v1" },
        catalog,
      ),
    ).toThrow(AgentBlueprintCompileError);
    expect(() =>
      compileAgentBlueprint(blueprint, {
        ...catalog,
        personas: [{ ...catalog.personas[0]!, status: "draft" }],
      }),
    ).toThrow(/UNPUBLISHED_REF/);
  });

  it("rejects missing, mismatched, and failed provider terminal receipts", async () => {
    const compiled = compileAgentBlueprint(blueprint, catalog);
    const handlers = new InMemoryAgentHandlerRegistry([
      { ...compiled.handlers.renderer, handler: () => "Review" },
      {
        ...compiled.handlers.normalizer!,
        handler: (context: unknown) =>
          (context as { output?: unknown }).output,
      },
      { ...compiled.handlers.validators[0]!, handler: () => true },
    ]);
    const execute = (
      invokeProvider: Parameters<
        typeof executeCompiledAgentBlueprint
      >[0]["invokeProvider"],
    ) =>
      executeCompiledAgentBlueprint({
        descriptor: compiled,
        handlers,
        input: {},
        invokeProvider,
      });

    await expect(
      execute(async () => ({ status: "completed", output: "approved" })),
    ).rejects.toMatchObject({ code: "PROVIDER_TERMINAL_RECEIPT_MISSING" });
    await expect(
      execute(async () => ({
        ...completedProviderResponse("approved"),
        terminalReceipt: {
          ...completedProviderResponse("approved").terminalReceipt,
          eventType: "failed",
        },
      })),
    ).rejects.toMatchObject({ code: "PROVIDER_TERMINAL_RECEIPT_MISSING" });
    await expect(
      execute(async () => ({
        status: "failed",
        terminalReason: "adapter failed",
        terminalReceipt: {
          eventType: "failed",
          attemptId: "attempt-1",
          providerId: "provider-a",
          usage: {
            kind: "unknown",
            reason: "Adapter ended without usage telemetry.",
          },
        },
      })),
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
  });
});

function completedProviderResponse(output: unknown) {
  return {
    status: "completed" as const,
    output,
    terminalReceipt: {
      eventType: "completed" as const,
      attemptId: "attempt-1",
      providerId: "provider-a",
      usage: { kind: "measured" as const, inputTokens: 1, outputTokens: 1 },
    },
  };
}

describe("agent handler registry", () => {
  it("invokes allowlisted pure functions by string ref", async () => {
    const registry = new InMemoryAgentHandlerRegistry([
      {
        ...catalog.handlers[1]!,
        handler: (input: unknown) => String(input).trim().toLowerCase(),
      },
    ]);
    await expect(
      registry.invoke<string, string>(
        "decision.normalize/v1",
        "normalizer",
        " ACCEPT ",
      ),
    ).resolves.toBe("accept");
  });

  it("blocks unknown, kind-mismatched, and disallowed-effect handlers", async () => {
    const registry = new InMemoryAgentHandlerRegistry([
      {
        ...catalog.handlers[0]!,
        effectClass: "read",
        handler: (input: unknown) => input,
      },
    ]);
    expect(() => registry.resolve("missing", "renderer")).toThrow(
      AgentHandlerRegistryError,
    );
    try {
      registry.resolve("prompt.render/v1", "validator");
      expect.unreachable("kind mismatch should fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentHandlerRegistryError);
      expect((error as AgentHandlerRegistryError).code).toBe(
        "HANDLER_KIND_MISMATCH",
      );
    }
    await expect(
      registry.invoke("prompt.render/v1", "renderer", {}),
    ).rejects.toThrow(/HANDLER_EFFECT_DENIED/);
  });
});

describe("compiled agent blueprint runtime", () => {
  it("composes registered stages around one host-provided provider call", async () => {
    const compiled = compileAgentBlueprint(
      {
        ...blueprint,
        handlers: {
          ...blueprint.handlers,
          evidenceResolvers: ["evidence.resolve/v1"],
          postprocessors: ["output.project/v1"],
        },
      },
      {
        ...catalog,
        handlers: [
          ...catalog.handlers,
          {
            ref: "evidence.resolve/v1",
            status: "published",
            kind: "evidence-resolver",
            version: 1,
            effectClass: "read",
            deterministic: true,
          },
          {
            ref: "output.project/v1",
            status: "published",
            kind: "postprocessor",
            version: 1,
            effectClass: "none",
            deterministic: true,
          },
        ],
      },
    );
    const handlers = new InMemoryAgentHandlerRegistry([
      {
        ...compiled.handlers.renderer,
        handler: (context: unknown) =>
          `Review ${String((context as { input: unknown }).input)}`,
      },
      {
        ...compiled.handlers.normalizer!,
        handler: (context: unknown) =>
          String((context as { output?: unknown }).output)
            .trim()
            .toLowerCase(),
      },
      {
        ...compiled.handlers.validators[0]!,
        handler: (context: unknown) => ({
          valid:
            (context as { output?: unknown }).output === "approved",
        }),
      },
      {
        ...compiled.handlers.evidenceResolvers[0]!,
        handler: () => ({ source: "host-validation" }),
      },
      {
        ...compiled.handlers.postprocessors[0]!,
        handler: (context: unknown) => ({
          decision: (context as { output?: unknown }).output,
        }),
      },
    ]);
    const invokeProvider = vi.fn(async ({ renderedPrompt }) => {
      expect(renderedPrompt).toBe("Review candidate");
      return {
        status: "completed" as const,
        output: " APPROVED ",
        terminalReceipt: {
          eventType: "completed" as const,
          attemptId: "attempt-1",
          providerId: "provider-a",
          usage: {
            kind: "measured" as const,
            inputTokens: 10,
            outputTokens: 3,
          },
        },
      };
    });

    await expect(
      executeCompiledAgentBlueprint({
        descriptor: compiled,
        handlers,
        input: "candidate",
        invokeProvider,
      }),
    ).resolves.toMatchObject({
      renderedPrompt: "Review candidate",
      rawOutput: " APPROVED ",
      normalizedOutput: "approved",
      output: { decision: "approved" },
      validatorResults: [{ valid: true }],
      evidence: [{
        handlerRef: "evidence.resolve/v1",
        value: { source: "host-validation" },
      }],
      authorityEffect: "advisory",
    });
    expect(invokeProvider).toHaveBeenCalledOnce();
  });

  it("resolves immutable compiled agents and aliases through one generic runtime", async () => {
    const reviewer = compileAgentBlueprint(blueprint, catalog);
    const coder = compileAgentBlueprint(
      {
        ...blueprint,
        id: "coder",
        personaRef: "persona.reviewer/v1",
      },
      catalog,
    );
    const handlers = new InMemoryAgentHandlerRegistry([
      { ...reviewer.handlers.renderer, handler: () => "Execute" },
      {
        ...reviewer.handlers.normalizer!,
        handler: (context: unknown) =>
          (context as { output?: unknown }).output,
      },
      { ...reviewer.handlers.validators[0]!, handler: () => true },
    ]);
    const first = new CompiledAgentRuntime({
      descriptors: [reviewer, coder],
      handlers,
      aliases: {
        implementer: "coder",
        judge: "reviewer",
      },
    });
    const second = new CompiledAgentRuntime({
      descriptors: [coder, reviewer],
      handlers,
      aliases: {
        judge: "reviewer",
        implementer: "coder",
      },
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.list().map(({ id }) => id)).toEqual([
      "coder",
      "reviewer",
    ]);
    expect(first.resolve("implementer")).toMatchObject({
      requestedId: "implementer",
      agentId: "coder",
      resolutionSource: "alias",
      runtimeFingerprint: first.fingerprint,
    });
    await expect(
      first.execute({
        agentId: "judge",
        input: { objective: "Review the candidate." },
        invokeProvider: async () =>
          completedProviderResponse("approved"),
      }),
    ).resolves.toMatchObject({
      output: "approved",
      selection: {
        requestedId: "judge",
        agentId: "reviewer",
        resolutionSource: "alias",
        runtimeFingerprint: first.fingerprint,
      },
    });
  });

  it("rejects unknown aliases, duplicate names, and descriptor drift", () => {
    const compiled = compileAgentBlueprint(blueprint, catalog);
    const handlers = new InMemoryAgentHandlerRegistry();
    expect(
      () =>
        new CompiledAgentRuntime({
          descriptors: [compiled],
          handlers,
          aliases: { missing: "unknown-agent" },
        }),
    ).toThrow(CompiledAgentRuntimeError);
    expect(
      () =>
        new CompiledAgentRuntime({
          descriptors: [compiled],
          handlers,
          aliases: { reviewer: "reviewer" },
        }),
    ).toThrow(/DUPLICATE_AGENT_NAME/);
    expect(
      () =>
        new CompiledAgentRuntime({
          descriptors: [
            {
              ...compiled,
              tools: ["repo.write"],
            },
          ],
          handlers,
        }),
    ).toThrow(/AGENT_DESCRIPTOR_FINGERPRINT_MISMATCH/);
  });

  it("rejects tampered descriptors and invalid output before postprocessing", async () => {
    const compiled = compileAgentBlueprint(blueprint, catalog);
    const tampered = {
      ...compiled,
      tools: ["repo.write"],
    };
    await expect(
      executeCompiledAgentBlueprint({
        descriptor: tampered,
        handlers: new InMemoryAgentHandlerRegistry(),
        input: {},
        invokeProvider: async () => completedProviderResponse("approved"),
      }),
    ).rejects.toMatchObject({
      code: "DESCRIPTOR_FINGERPRINT_MISMATCH",
    });

    const handlers = new InMemoryAgentHandlerRegistry([
      {
        ...compiled.handlers.renderer,
        handler: () => "Review",
      },
      {
        ...compiled.handlers.normalizer!,
        handler: (context: unknown) =>
          (context as { output?: unknown }).output,
      },
      {
        ...compiled.handlers.validators[0]!,
        handler: () => ({
          valid: false,
          diagnostics: ["validation evidence is missing"],
        }),
      },
    ]);
    await expect(
      executeCompiledAgentBlueprint({
        descriptor: compiled,
        handlers,
        input: {},
        invokeProvider: async () => completedProviderResponse("approved"),
      }),
    ).rejects.toEqual(expect.objectContaining({
      code: "OUTPUT_INVALID",
      diagnostics: ["validation evidence is missing"],
    }) satisfies Partial<AgentBlueprintExecutionError>);
  });
});
