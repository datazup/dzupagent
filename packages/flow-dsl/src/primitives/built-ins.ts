import type { PrimitiveDefinition } from "./types.js";
import { expandCollabReviewLoop } from "./collab-review-loop.js";
import { createPrimitiveRegistry } from "./registry.js";

export const BUILT_IN_PRIMITIVES: readonly PrimitiveDefinition[] =
  Object.freeze([
    {
      kind: "adapter.run",
      version: "1",
      namespace: "adapter",
      category: "leaf",
      description: "Run one provider adapter call through the host registry.",
      effectClass: "llm",
      idempotency: "at-least-once",
      schema: {
        type: "object",
        required: ["instructions", "output"],
        properties: {
          provider: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          instructions: { type: "string", minLength: 1 },
          output: { type: "string", minLength: 1 },
        },
      },
      executesWith: "adapter.run",
    },
    {
      kind: "validate",
      version: "1",
      namespace: "validate",
      category: "validator",
      description: "Run validation commands or a referenced validation suite.",
      effectClass: "compute",
      idempotency: "idempotent",
      schema: { type: "object" },
      executesWith: "validate",
    },
    {
      kind: "approval",
      version: "1",
      namespace: "human",
      category: "leaf",
      description: "Pause for a human approval decision.",
      effectClass: "human_decision",
      idempotency: "exactly-once-required",
      schema: { type: "object" },
      executesWith: "approval",
    },
    {
      kind: "collab.review_loop",
      version: "1",
      namespace: "collab",
      category: "composite",
      description: "Propose, cross-validate, run gates, and reconcile.",
      effectClass: "llm",
      idempotency: "at-least-once",
      schema: { type: "object" },
      expandsTo: ["adapter.run", "validate", "if", "approval", "complete"],
      expand: expandCollabReviewLoop,
    },
  ]);

export const DEFAULT_PRIMITIVE_REGISTRY =
  createPrimitiveRegistry(BUILT_IN_PRIMITIVES);
