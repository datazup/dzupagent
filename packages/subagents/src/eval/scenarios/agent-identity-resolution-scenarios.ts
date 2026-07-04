import type { FanoutEvalCase } from "../types.js";
import type { AgentIdentityResolutionCase } from "../agent-identity-resolution-scorer.js";

export const AGENT_IDENTITY_RESOLUTION_SCENARIOS: Array<
  FanoutEvalCase<AgentIdentityResolutionCase>
> = [
  {
    id: "air-001-plain-agent-id-no-instructions",
    description:
      "no instruction template: every item resolves to the bare template agentId.",
    tags: ["known-good"],
    input: {
      template: { agentId: "reviewer" },
      items: [
        { key: "a", input: "alpha" },
        { key: "b", input: "beta" },
      ],
      expected: {
        a: { agentId: "reviewer" },
        b: { agentId: "reviewer" },
      },
    },
  },
  {
    id: "air-002-instruction-placeholder-substitution",
    description:
      "{{key}} and {{input}} placeholders substitute correctly per item.",
    tags: ["known-good"],
    input: {
      template: {
        agentId: "worker",
        instructions: "Process item {{key}} with payload: {{input}}",
      },
      items: [
        { key: "x1", input: "hello" },
        { key: "x2", input: "world" },
      ],
      expected: {
        x1: {
          agentId: "worker",
          instructions: "Process item x1 with payload: hello",
        },
        x2: {
          agentId: "worker",
          instructions: "Process item x2 with payload: world",
        },
      },
    },
  },
  {
    id: "air-003-object-input-serialized-into-instructions",
    description:
      "a structured (object) item input is JSON-serialized into the instruction template.",
    tags: ["known-good"],
    input: {
      template: { agentId: "worker", instructions: "Handle: {{input}}" },
      items: [{ key: "obj1", input: { foo: "bar", n: 1 } }],
      expected: {
        obj1: {
          agentId: "worker",
          instructions: 'Handle: {"foo":"bar","n":1}',
        },
      },
    },
  },
];

/**
 * A deliberately WRONG expectation (agentId typo) used only by the scorer
 * meta-tests to assert the scorer catches an identity resolution mismatch.
 */
export const AGENT_IDENTITY_RESOLUTION_KNOWN_BAD_CASE: FanoutEvalCase<AgentIdentityResolutionCase> =
  {
    id: "air-bad-001-wrong-expected-agent-id",
    description: "expected agentId does not match the template's agentId.",
    tags: ["known-bad"],
    input: {
      template: { agentId: "reviewer" },
      items: [{ key: "a", input: "alpha" }],
      expected: {
        a: { agentId: "some-other-agent" },
      },
    },
  };
