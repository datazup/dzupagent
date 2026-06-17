import type { AdapterRunNode } from "../types.js";
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from "./shared.js";

const ADAPTER_PROVIDERS = new Set<NonNullable<AdapterRunNode["provider"]>>([
  "claude",
  "codex",
  "gemini",
  "qwen",
  "goose",
  "crush",
]);
const REASONING_LEVELS = new Set<NonNullable<AdapterRunNode["reasoning"]>>([
  "low",
  "medium",
  "high",
]);
const PROMPT_PREP_MODES = new Set<NonNullable<AdapterRunNode["promptPrep"]>>([
  "auto",
  "raw",
]);
const IDEMPOTENCY_MODES = new Set<NonNullable<AdapterRunNode["idempotency"]>>([
  "idempotent",
  "at-least-once",
  "exactly-once-required",
]);

export function parseAdapterRun(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): AdapterRunNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);

  // Provider / tags routing: exactly one of the two must be present, and
  // `provider` (when present) must be a known adapter provider.
  const hasTags = obj.tags !== undefined;
  const hasProvider = obj.provider !== undefined;
  let provider: AdapterRunNode["provider"] | undefined;
  let tags: string[] | undefined;

  if (hasProvider) {
    if (
      typeof obj.provider !== "string" ||
      !ADAPTER_PROVIDERS.has(
        obj.provider as NonNullable<AdapterRunNode["provider"]>
      )
    ) {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: `adapter.run.provider must be one of ${[
          ...ADAPTER_PROVIDERS,
        ].join("|")}, received ${describeJsType(obj.provider)}`,
        pointer: joinPointer(pointer, "provider"),
      });
      return null;
    }
    provider = obj.provider as AdapterRunNode["provider"];
  }

  if (hasTags) {
    if (
      Array.isArray(obj.tags) &&
      obj.tags.length > 0 &&
      obj.tags.every((v): v is string => typeof v === "string")
    ) {
      tags = obj.tags;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message:
          "adapter.run.tags must be a non-empty array of strings when present",
        pointer: joinPointer(pointer, "tags"),
      });
      return null;
    }
  }

  if (!hasProvider && !hasTags) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message:
        "adapter.run requires one of provider or tags to select an adapter",
      pointer: joinPointer(pointer, "provider"),
    });
    return null;
  }

  const instructions = obj.instructions;
  if (typeof instructions !== "string" || instructions.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `adapter.run.instructions must be a non-empty string, received ${describeJsType(
        instructions
      )}`,
      pointer: joinPointer(pointer, "instructions"),
    });
    return null;
  }

  const output = obj.output;
  if (typeof output !== "string" || output.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `adapter.run.output must be a non-empty string, received ${describeJsType(
        output
      )}`,
      pointer: joinPointer(pointer, "output"),
    });
    return null;
  }

  const node: AdapterRunNode = {
    type: "adapter.run",
    ...common,
    instructions,
    output,
  };

  if (provider !== undefined) node.provider = provider;
  if (tags !== undefined) node.tags = tags;
  if (typeof obj.model === "string") node.model = obj.model;
  if (typeof obj.systemPrompt === "string")
    node.systemPrompt = obj.systemPrompt;
  if (typeof obj.persona === "string") node.persona = obj.persona;

  if (obj.input !== undefined) {
    if (
      typeof obj.input === "object" &&
      obj.input !== null &&
      !Array.isArray(obj.input)
    ) {
      node.input = obj.input as Record<string, unknown>;
    } else {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: `adapter.run.input must be an object when present, received ${describeJsType(
          obj.input
        )}`,
        pointer: joinPointer(pointer, "input"),
      });
      return null;
    }
  }

  if (obj.reasoning !== undefined) {
    if (
      typeof obj.reasoning === "string" &&
      REASONING_LEVELS.has(
        obj.reasoning as NonNullable<AdapterRunNode["reasoning"]>
      )
    ) {
      node.reasoning = obj.reasoning as NonNullable<
        AdapterRunNode["reasoning"]
      >;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: 'adapter.run.reasoning must be "low", "medium", or "high"',
        pointer: joinPointer(pointer, "reasoning"),
      });
      return null;
    }
  }

  if (obj.outputSchema !== undefined) {
    if (typeof obj.outputSchema === "string") {
      node.outputSchema = obj.outputSchema;
    } else if (
      typeof obj.outputSchema === "object" &&
      obj.outputSchema !== null &&
      !Array.isArray(obj.outputSchema)
    ) {
      node.outputSchema = obj.outputSchema as Record<string, unknown>;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message:
          "adapter.run.outputSchema must be a schema ref string or an inline object",
        pointer: joinPointer(pointer, "outputSchema"),
      });
      return null;
    }
  }

  if (obj.promptPrep !== undefined) {
    if (
      typeof obj.promptPrep === "string" &&
      PROMPT_PREP_MODES.has(
        obj.promptPrep as NonNullable<AdapterRunNode["promptPrep"]>
      )
    ) {
      node.promptPrep = obj.promptPrep as NonNullable<
        AdapterRunNode["promptPrep"]
      >;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: 'adapter.run.promptPrep must be "auto" or "raw"',
        pointer: joinPointer(pointer, "promptPrep"),
      });
      return null;
    }
  }

  if (obj.idempotency !== undefined) {
    if (
      typeof obj.idempotency === "string" &&
      IDEMPOTENCY_MODES.has(
        obj.idempotency as NonNullable<AdapterRunNode["idempotency"]>
      )
    ) {
      node.idempotency = obj.idempotency as NonNullable<
        AdapterRunNode["idempotency"]
      >;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message:
          'adapter.run.idempotency must be "idempotent", "at-least-once", or "exactly-once-required"',
        pointer: joinPointer(pointer, "idempotency"),
      });
      return null;
    }
  }

  if (obj.policy !== undefined) {
    if (
      typeof obj.policy === "object" &&
      obj.policy !== null &&
      !Array.isArray(obj.policy)
    ) {
      node.policy = obj.policy as Record<string, unknown>;
    } else {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: `adapter.run.policy must be an object when present, received ${describeJsType(
          obj.policy
        )}`,
        pointer: joinPointer(pointer, "policy"),
      });
      return null;
    }
  }

  return node;
}
