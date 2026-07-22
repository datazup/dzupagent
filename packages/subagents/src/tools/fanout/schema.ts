/**
 * Static tool-descriptor surface for `fanout_template`: the LLM-facing name,
 * description, and JSON-schema `parameters`. Split from the coordinator so the
 * (large) orchestration body and the (static) contract can evolve
 * independently.
 */

export const FANOUT_TEMPLATE_TOOL_NAME = "fanout_template";

export const FANOUT_TEMPLATE_TOOL_DESCRIPTION =
  "Dispatch the SAME operation across a known list of items (use for ≥3 items) with a structural coverage guarantee: every declared item is spawned as a background subagent exactly once and reported with an honest terminal status. Provide unique item keys and a per-item spec template ({{key}}/{{input}} placeholders are substituted into instructions). Returns a FanoutReport; a non-empty `uncovered` array means coverage failed. Use spawn_subagent/await_subagent for singleton or interactive work.";

export const FANOUT_TEMPLATE_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description:
        "Declared items to process. Every item MUST be listed here — coverage is measured against this list.",
      items: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Unique key identifying the item.",
          },
          input: { description: "The per-item task input." },
        },
        required: ["key", "input"],
      },
    },
    spec: {
      type: "object",
      description: "Per-item SubagentSpec template.",
      properties: {
        agentId: {
          type: "string",
          description: "Which agent to dispatch for every item.",
        },
        instructions: {
          type: "string",
          description:
            "Optional instruction template; {{key}} and {{input}} are substituted per item.",
        },
        outboundScope: { type: "array", items: { type: "string" } },
        memoryScope: {
          type: "string",
          enum: ["global", "workspace", "project", "agent"],
        },
      },
      required: ["agentId"],
    },
    concurrency: {
      type: "number",
      description: "Max in-flight items (clamped to the host limit).",
    },
    ttlMs: {
      type: "number",
      description: "Optional per-item time-to-live in milliseconds.",
    },
    budget: {
      type: "object",
      properties: {
        maxTotalOutputTokens: { type: "number" },
        maxWallClockMs: { type: "number" },
      },
    },
  },
  required: ["items", "spec"],
};
