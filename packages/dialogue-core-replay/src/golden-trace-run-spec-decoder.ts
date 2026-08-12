import type {
  BudgetSpec,
  DecidePolicy,
  DialogueMode,
  ParticipantSpec,
  RunLoopSpec,
  RunSpec,
  RunTurnSpec,
  TurnVerb,
} from "@dzupagent/dialogue-core";
import { TURN_VERBS } from "@dzupagent/dialogue-core";

import {
  decodeBranch,
  decodeHandoff,
} from "./golden-trace-branch-decoder.js";
import type { GoldenTraceDecodeContext } from "./golden-trace-decode-context.js";
import {
  optionalArray,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalValue,
  requiredString,
  requiredStringArray,
} from "./golden-trace-schema-helpers.js";
import { decodeValidationSpec } from "./golden-trace-validation-spec-decoder.js";

const DIALOGUE_MODES = ["deliberate", "build"] as const;
const DIRTY_POLICIES = ["reject", "isolate", "allow"] as const;

export function decodeRunSpec(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): RunSpec {
  return context.record(
    value,
    path,
    depth,
    ["mode", "participants", "turns"],
    [
      "loops",
      "decidePolicy",
      "budget",
      "maxIterations",
      "allowEscape",
      "dirtyPolicy",
    ],
    (record) => {
      const mode = decodeDialogueMode(
        context,
        context.required(record, "mode", path),
        `${path}.mode`,
        depth + 1,
      );
      const participants = context.array(
        context.required(record, "participants", path),
        `${path}.participants`,
        depth + 1,
        (item, itemPath, itemDepth) =>
          decodeParticipant(context, item, itemPath, itemDepth),
      );
      const turns = context.array(
        context.required(record, "turns", path),
        `${path}.turns`,
        depth + 1,
        (item, itemPath, itemDepth) =>
          decodeRunTurn(context, item, itemPath, itemDepth),
      );
      const loops = optionalArray(
        context,
        record,
        "loops",
        path,
        depth,
        decodeRunLoop,
      );
      const decidePolicy = optionalValue(
        context,
        record,
        "decidePolicy",
        path,
        depth,
        decodeDecidePolicy,
      );
      const budget = optionalValue(
        context,
        record,
        "budget",
        path,
        depth,
        decodeBudget,
      );
      const maxIterations = optionalNumber(
        context,
        record,
        "maxIterations",
        path,
        depth,
        "non-negative-integer",
      );
      const allowEscape = optionalBoolean(
        context,
        record,
        "allowEscape",
        path,
        depth,
      );
      const dirtyPolicy = record.has("dirtyPolicy")
        ? context.literal(
            record.get("dirtyPolicy"),
            `${path}.dirtyPolicy`,
            depth + 1,
            DIRTY_POLICIES,
          )
        : undefined;

      return {
        mode,
        participants,
        turns,
        ...(loops === undefined ? {} : { loops }),
        ...(decidePolicy === undefined ? {} : { decidePolicy }),
        ...(budget === undefined ? {} : { budget }),
        ...(maxIterations === undefined ? {} : { maxIterations }),
        ...(allowEscape === undefined ? {} : { allowEscape }),
        ...(dirtyPolicy === undefined ? {} : { dirtyPolicy }),
      };
    },
  );
}

export function decodeTurnVerb(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): TurnVerb {
  return context.literal(value, path, depth, TURN_VERBS);
}

export function decodeDialogueMode(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): DialogueMode {
  return context.literal(value, path, depth, DIALOGUE_MODES);
}

function decodeParticipant(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): ParticipantSpec {
  return context.record(
    value,
    path,
    depth,
    ["id", "provider", "model"],
    ["role", "systemPrompt"],
    (record) => {
      const id = requiredString(context, record, "id", path, depth);
      const provider = requiredString(
        context,
        record,
        "provider",
        path,
        depth,
      );
      const model = requiredString(context, record, "model", path, depth);
      const role = optionalString(context, record, "role", path, depth);
      const systemPrompt = optionalString(
        context,
        record,
        "systemPrompt",
        path,
        depth,
      );
      return {
        id,
        provider,
        model,
        ...(role === undefined ? {} : { role }),
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
      };
    },
  );
}

function decodeRunTurn(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): RunTurnSpec {
  return context.record(
    value,
    path,
    depth,
    ["id", "verb"],
    ["participantId", "prompt", "validation", "handoff", "branch"],
    (record) => {
      const id = requiredString(context, record, "id", path, depth);
      const verb = decodeTurnVerb(
        context,
        context.required(record, "verb", path),
        `${path}.verb`,
        depth + 1,
      );
      const participantId = optionalString(
        context,
        record,
        "participantId",
        path,
        depth,
      );
      const prompt = optionalString(context, record, "prompt", path, depth);
      const validation = optionalValue(
        context,
        record,
        "validation",
        path,
        depth,
        decodeValidationSpec,
      );
      const handoff = optionalValue(
        context,
        record,
        "handoff",
        path,
        depth,
        decodeHandoff,
      );
      const branch = optionalValue(
        context,
        record,
        "branch",
        path,
        depth,
        decodeBranch,
      );
      return {
        id,
        verb,
        ...(participantId === undefined ? {} : { participantId }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(validation === undefined ? {} : { validation }),
        ...(handoff === undefined ? {} : { handoff }),
        ...(branch === undefined ? {} : { branch }),
      };
    },
  );
}

function decodeRunLoop(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): RunLoopSpec {
  return context.record(
    value,
    path,
    depth,
    ["id", "condition", "turnIds", "maxIterations"],
    [],
    (record) => ({
      id: requiredString(context, record, "id", path, depth),
      condition: requiredString(
        context,
        record,
        "condition",
        path,
        depth,
      ),
      turnIds: requiredStringArray(
        context,
        record,
        "turnIds",
        path,
        depth,
      ),
      maxIterations: context.number(
        context.required(record, "maxIterations", path),
        `${path}.maxIterations`,
        depth + 1,
        "non-negative-integer",
      ),
    }),
  );
}

function decodeDecidePolicy(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): DecidePolicy {
  return context.record(
    value,
    path,
    depth,
    ["kind"],
    ["participantId", "ruleId"],
    (record) => {
      const kind = context.literal(
        context.required(record, "kind", path),
        `${path}.kind`,
        depth + 1,
        ["agent", "rule"] as const,
      );
      if (kind === "agent") {
        context.assertAbsent(record, "ruleId", path);
        return {
          kind,
          participantId: requiredString(
            context,
            record,
            "participantId",
            path,
            depth,
          ),
        };
      }
      context.assertAbsent(record, "participantId", path);
      return {
        kind,
        ruleId: requiredString(context, record, "ruleId", path, depth),
      };
    },
  );
}

function decodeBudget(
  context: GoldenTraceDecodeContext,
  value: unknown,
  path: string,
  depth: number,
): BudgetSpec {
  return context.record(
    value,
    path,
    depth,
    [],
    ["maxUsd", "maxInputTokens", "maxOutputTokens"],
    (record) => {
      const maxUsd = optionalNumber(
        context,
        record,
        "maxUsd",
        path,
        depth,
        "non-negative",
      );
      const maxInputTokens = optionalNumber(
        context,
        record,
        "maxInputTokens",
        path,
        depth,
        "non-negative-integer",
      );
      const maxOutputTokens = optionalNumber(
        context,
        record,
        "maxOutputTokens",
        path,
        depth,
        "non-negative-integer",
      );
      return {
        ...(maxUsd === undefined ? {} : { maxUsd }),
        ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      };
    },
  );
}
