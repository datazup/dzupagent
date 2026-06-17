import type { AdapterRaceNode } from "../types.js";
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from "./shared.js";

type RaceProvider = AdapterRaceNode["providers"][number];

const ADAPTER_PROVIDERS = new Set<RaceProvider>([
  "claude",
  "codex",
  "gemini",
  "qwen",
  "goose",
  "crush",
]);
const REASONING_LEVELS = new Set<NonNullable<AdapterRaceNode["reasoning"]>>([
  "low",
  "medium",
  "high",
]);
const PROMPT_PREP_MODES = new Set<NonNullable<AdapterRaceNode["promptPrep"]>>([
  "auto",
  "raw",
]);
const IDEMPOTENCY_MODES = new Set<NonNullable<AdapterRaceNode["idempotency"]>>([
  "idempotent",
  "at-least-once",
  "exactly-once-required",
]);

export function parseAdapterRace(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): AdapterRaceNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);

  // providers: array of ≥2 known providers raced on the same prompt.
  if (
    !Array.isArray(obj.providers) ||
    obj.providers.length < 2 ||
    !obj.providers.every(
      (v): v is RaceProvider =>
        typeof v === "string" && ADAPTER_PROVIDERS.has(v as RaceProvider)
    )
  ) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `adapter.race.providers must be an array of at least 2 providers from ${[
        ...ADAPTER_PROVIDERS,
      ].join("|")}, received ${describeJsType(obj.providers)}`,
      pointer: joinPointer(pointer, "providers"),
    });
    return null;
  }
  const providers = obj.providers as RaceProvider[];

  const instructions = obj.instructions;
  if (typeof instructions !== "string" || instructions.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `adapter.race.instructions must be a non-empty string, received ${describeJsType(
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
      message: `adapter.race.output must be a non-empty string, received ${describeJsType(
        output
      )}`,
      pointer: joinPointer(pointer, "output"),
    });
    return null;
  }

  const node: AdapterRaceNode = {
    type: "adapter.race",
    ...common,
    providers,
    instructions,
    output,
  };

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
        message: `adapter.race.input must be an object when present, received ${describeJsType(
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
        obj.reasoning as NonNullable<AdapterRaceNode["reasoning"]>
      )
    ) {
      node.reasoning = obj.reasoning as NonNullable<
        AdapterRaceNode["reasoning"]
      >;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: 'adapter.race.reasoning must be "low", "medium", or "high"',
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
          "adapter.race.outputSchema must be a schema ref string or an inline object",
        pointer: joinPointer(pointer, "outputSchema"),
      });
      return null;
    }
  }

  if (obj.promptPrep !== undefined) {
    if (
      typeof obj.promptPrep === "string" &&
      PROMPT_PREP_MODES.has(
        obj.promptPrep as NonNullable<AdapterRaceNode["promptPrep"]>
      )
    ) {
      node.promptPrep = obj.promptPrep as NonNullable<
        AdapterRaceNode["promptPrep"]
      >;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: 'adapter.race.promptPrep must be "auto" or "raw"',
        pointer: joinPointer(pointer, "promptPrep"),
      });
      return null;
    }
  }

  if (obj.idempotency !== undefined) {
    if (
      typeof obj.idempotency === "string" &&
      IDEMPOTENCY_MODES.has(
        obj.idempotency as NonNullable<AdapterRaceNode["idempotency"]>
      )
    ) {
      node.idempotency = obj.idempotency as NonNullable<
        AdapterRaceNode["idempotency"]
      >;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message:
          'adapter.race.idempotency must be "idempotent", "at-least-once", or "exactly-once-required"',
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
        message: `adapter.race.policy must be an object when present, received ${describeJsType(
          obj.policy
        )}`,
        pointer: joinPointer(pointer, "policy"),
      });
      return null;
    }
  }

  return node;
}
