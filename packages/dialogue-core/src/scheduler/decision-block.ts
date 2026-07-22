import type { DecisionBlock } from "../types/turn-event.js";

/**
 * Internal-only helpers that parse a model's raw output into a
 * {@link DecisionBlock} and evaluate rule-based decisions. Extracted from
 * `dialogue-scheduler.ts` with zero behavior change; not part of the frozen
 * public API surface (see `CONTRACT_FREEZE.md`).
 */

export function parseDecisionBlock(raw: string): DecisionBlock {
  const parsed = parseJsonObject(raw);
  const candidate = getNestedDecisionCandidate(parsed);
  const wouldFlipIf =
    typeof candidate.wouldFlipIf === "string"
      ? candidate.wouldFlipIf
      : undefined;

  return {
    verdict: parseVerdict(candidate.verdict),
    criteria: parseCriteria(candidate.criteria),
    rationale: parseString(candidate.rationale, raw),
    ...(wouldFlipIf !== undefined ? { wouldFlipIf } : {}),
  };
}

function getNestedDecisionCandidate(
  parsed: Record<string, unknown>
): Record<string, unknown> {
  const nestedDecision = parsed.decision;

  if (
    nestedDecision !== undefined &&
    nestedDecision !== null &&
    typeof nestedDecision === "object"
  ) {
    return nestedDecision as Record<string, unknown>;
  }

  return parsed;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  return {};
}

function parseVerdict(value: unknown): DecisionBlock["verdict"] {
  switch (value) {
    case "stop":
    case "branch":
    case "accept":
    case "reject":
      return value;
    case "continue":
    default:
      return "continue";
  }
}

function parseCriteria(value: unknown): DecisionBlock["criteria"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (item === null || typeof item !== "object") {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const name =
      typeof candidate.name === "string" ? candidate.name : undefined;
    const met = typeof candidate.met === "boolean" ? candidate.met : undefined;

    if (name === undefined || met === undefined) {
      return [];
    }

    return [
      {
        name,
        met,
        ...(typeof candidate.weight === "number"
          ? { weight: candidate.weight }
          : {}),
      },
    ];
  });
}

function parseString(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }

  return fallback;
}

export function evaluateRuleDecision(ruleId: string): DecisionBlock {
  return {
    verdict: "continue",
    criteria: [
      {
        name: ruleId,
        met: true,
      },
    ],
    rationale: `Rule ${ruleId} evaluated by dialogue-core.`,
  };
}

export function shouldStopAfterDecision(
  decision: DecisionBlock | undefined
): decision is DecisionBlock {
  return (
    decision?.verdict === "stop" ||
    decision?.verdict === "accept" ||
    decision?.verdict === "reject"
  );
}
