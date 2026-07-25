import { describe, expect, it } from "vitest";

import {
  AGENT_BLUEPRINT_SCHEMA,
  COMPILED_AGENT_DESCRIPTOR_SCHEMA,
  validateAgentBlueprint,
  validateCompiledAgentDescriptor,
  type AgentBlueprint,
  type CompiledAgentDescriptor,
} from "../agent-blueprint.js";

const blueprint: AgentBlueprint = {
  schema: AGENT_BLUEPRINT_SCHEMA,
  id: "reviewer",
  version: 1,
  status: "published",
  personaRef: "persona.reviewer/v1",
  taskRef: "task.review/v1",
  inputSchemaRef: "schema.review-input/v1",
  outputSchemaRef: "schema.review-output/v1",
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

describe("agent blueprint contracts", () => {
  it("accepts a versioned blueprint with no executable functions", () => {
    expect(validateAgentBlueprint(blueprint)).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("requires a renderer, validator, and unique references", () => {
    const invalid = {
      ...blueprint,
      handlers: { renderer: "", validators: ["same", "same"] },
      evidenceKinds: ["validation", "validation"],
    };
    expect(
      validateAgentBlueprint(invalid).diagnostics.map(({ code }) => code),
    ).toEqual([
      "INVALID_VALUE",
      "DUPLICATE_REF",
      "DUPLICATE_REF",
    ]);
  });

  it("rejects malformed fingerprints and handler-kind drift", () => {
    const descriptor = {
      schema: COMPILED_AGENT_DESCRIPTOR_SCHEMA,
      id: "reviewer",
      blueprintVersion: 1,
      personaRef: blueprint.personaRef,
      taskRef: blueprint.taskRef,
      promptLayers: [
        {
          kind: "persona",
          ref: "p",
          content: "persona",
          contentSha256: `sha256:${"a".repeat(64)}`,
        },
        {
          kind: "task",
          ref: "t",
          content: "task",
          contentSha256: `sha256:${"b".repeat(64)}`,
        },
      ],
      inputSchema: {},
      outputSchema: {},
      tools: [],
      policy: {},
      handlers: {
        renderer: {
          ref: "renderer",
          status: "published",
          kind: "validator",
          version: 1,
          effectClass: "none",
          deterministic: true,
        },
        validators: [],
        evidenceResolvers: [],
        postprocessors: [],
      },
      evidenceKinds: [],
      authorityEffect: "advisory",
      sourceRefs: ["p", "t"],
      fingerprint: "sha256:not-a-digest",
    } as unknown as CompiledAgentDescriptor;

    expect(
      validateCompiledAgentDescriptor(descriptor).diagnostics.map(({ code }) => code),
    ).toEqual(["INVALID_FINGERPRINT", "HANDLER_KIND_MISMATCH"]);
  });

  it("rejects a compiled prompt layer without a content identity", () => {
    const descriptor = {
      schema: COMPILED_AGENT_DESCRIPTOR_SCHEMA,
      id: "reviewer",
      blueprintVersion: 1,
      personaRef: blueprint.personaRef,
      taskRef: blueprint.taskRef,
      promptLayers: [
        {
          kind: "persona",
          ref: "p",
          content: "persona",
          contentSha256: "not-a-digest",
        },
        {
          kind: "task",
          ref: "t",
          content: "task",
          contentSha256: `sha256:${"b".repeat(64)}`,
        },
      ],
      inputSchema: {},
      outputSchema: {},
      tools: [],
      policy: {},
      handlers: {
        renderer: {
          ref: "renderer",
          status: "published",
          kind: "renderer",
          version: 1,
          effectClass: "none",
          deterministic: true,
        },
        validators: [],
        evidenceResolvers: [],
        postprocessors: [],
      },
      evidenceKinds: [],
      authorityEffect: "advisory",
      sourceRefs: ["p", "t"],
      fingerprint: `sha256:${"c".repeat(64)}`,
    } as unknown as CompiledAgentDescriptor;

    expect(validateCompiledAgentDescriptor(descriptor).diagnostics).toContainEqual({
      code: "INVALID_FINGERPRINT",
      path: "promptLayers[0].contentSha256",
      message: "Prompt-layer identity must be a lowercase SHA-256 digest.",
    });
  });
});
