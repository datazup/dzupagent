import type { DecisionBlock } from "../types/turn-event.js";

/**
 * Internal-only helpers that parse a model's raw output into a
 * {@link DecisionBlock} and evaluate rule-based decisions. Extracted from
 * `dialogue-scheduler.ts`; not part of the frozen public API surface (see
 * `CONTRACT_FREEZE.md`). The frozen verdict fallback is unchanged; fallbacks
 * now carry the additive `diagnostic` field (DZUPAGENT-ERR-C-24).
 */

export function parseDecisionBlock(raw: string): DecisionBlock {
  const parsed = parseJsonObject(raw);
  const candidate = getNestedDecisionCandidate(parsed ?? {});
  const wouldFlipIf =
    typeof candidate.wouldFlipIf === "string"
      ? candidate.wouldFlipIf
      : undefined;
  // The verdict keeps its frozen `continue` fallback, but a fallback is never
  // silent: malformed or truncated output (e.g. a cut-off `reject`) is marked
  // so hosts can tell it apart from a genuine `continue`.
  const diagnostic: DecisionBlock["diagnostic"] =
    parsed === undefined
      ? "unparseable"
      : isVerdict(candidate.verdict)
        ? undefined
        : "unrecognized-verdict";

  return {
    verdict: parseVerdict(candidate.verdict),
    criteria: parseCriteria(candidate.criteria),
    rationale: parseString(candidate.rationale, raw),
    ...(wouldFlipIf !== undefined ? { wouldFlipIf } : {}),
    ...(diagnostic !== undefined ? { diagnostic } : {}),
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

/** Returns the parsed JSON object, or `undefined` when `raw` is not one. */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
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
    return undefined;
  }

  return undefined;
}

function isVerdict(value: unknown): value is DecisionBlock["verdict"] {
  return (
    value === "continue" ||
    value === "stop" ||
    value === "branch" ||
    value === "accept" ||
    value === "reject"
  );
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

/**
 * dialogue-core has no rule engine: a `rule` decide policy is recorded as
 * not evaluated (`met: false` plus the `rule-not-evaluated` diagnostic) rather
 * than reported as a satisfied criterion. The verdict stays `continue`.
 */
export function evaluateRuleDecision(ruleId: string): DecisionBlock {
  return {
    verdict: "continue",
    criteria: [
      {
        name: ruleId,
        met: false,
      },
    ],
    rationale: `Rule ${ruleId} was not evaluated: dialogue-core has no rule engine.`,
    diagnostic: "rule-not-evaluated",
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

/**
 * Marks a run's stopReason when any review turn fell back on a malformed or
 * unrecognized decision (DZUPAGENT-ERR-C-24), so a host reading only the
 * result can tell a fallback `continue` apart from a genuine one. A
 * `rule-not-evaluated` diagnostic is not a parse failure and adds nothing.
 */
export function withDecisionParseSuffix(
  stopReason: string | undefined,
  diagnostic: DecisionBlock["diagnostic"]
): string | undefined {
  if (diagnostic !== "unparseable" && diagnostic !== "unrecognized-verdict") {
    return stopReason;
  }
  const suffix = `decision-parse=${diagnostic}`;
  return stopReason === undefined ? suffix : `${stopReason};${suffix}`;
}
