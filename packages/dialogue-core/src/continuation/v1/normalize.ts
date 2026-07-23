import {
  CONTINUATION_PROPOSAL_SCHEMA_V1,
  CONTINUATION_V1_MAX_EVIDENCE_REF_LENGTH,
  CONTINUATION_V1_MAX_EVIDENCE_REFS,
  CONTINUATION_V1_MAX_NEXT_TASK_LENGTH,
  CONTINUATION_V1_MAX_RATIONALE_LENGTH,
  type ContinuationDiagnosticCodeV1,
  type ContinuationNormalizationResultV1,
  type ContinuationNormalizationRuleV1,
  type ContinuationProposalV1,
  type ContinuationVerdictV1,
} from "./types.js";

const PROPOSAL_FIELDS = new Set([
  "schema",
  "verdict",
  "nextTask",
  "rationale",
  "evidenceRefs",
]);

export function normalizeContinuationProposalV1(
  raw: unknown
): ContinuationNormalizationResultV1 {
  const decoded = decodeProposalInput(raw);
  if (decoded.value === undefined) {
    return invalidResult(decoded.appliedRules, decoded.diagnostics);
  }

  const diagnostics = [...decoded.diagnostics];
  const candidate = decoded.value;

  if (Object.keys(candidate).some((key) => !PROPOSAL_FIELDS.has(key))) {
    diagnostics.push("proposal.unknown_field");
  }

  if (candidate["schema"] !== CONTINUATION_PROPOSAL_SCHEMA_V1) {
    diagnostics.push("proposal.schema_invalid");
  }

  const verdict = parseVerdict(candidate["verdict"]);
  if (verdict === undefined) {
    diagnostics.push("proposal.verdict_unknown");
  }

  const normalizedStrings = normalizeStringFields(candidate);
  if (normalizedStrings.trimmed) {
    decoded.appliedRules.push("trim_strings");
  }

  validateNextTask(verdict, normalizedStrings.nextTask, diagnostics);
  validateRationale(normalizedStrings.rationale, diagnostics);
  const evidenceRefResult = validateEvidenceRefs(
    candidate["evidenceRefs"],
    diagnostics
  );
  if (evidenceRefResult.trimmed) {
    decoded.appliedRules.push("trim_strings");
  }

  const uniqueDiagnostics = unique(diagnostics);
  if (
    uniqueDiagnostics.length > 0 ||
    verdict === undefined ||
    evidenceRefResult.refs === undefined
  ) {
    return invalidResult(decoded.appliedRules, uniqueDiagnostics);
  }

  const proposal = buildProposal(
    verdict,
    normalizedStrings.nextTask,
    normalizedStrings.rationale,
    evidenceRefResult.refs
  );

  return {
    schema: "dzupagent/continuation-normalization/v1",
    status: "valid",
    proposal,
    appliedRules: unique(decoded.appliedRules),
    diagnostics: [],
  };
}

interface DecodedProposalInput {
  readonly value?: Record<string, unknown>;
  readonly diagnostics: ContinuationDiagnosticCodeV1[];
  readonly appliedRules: ContinuationNormalizationRuleV1[];
}

function decodeProposalInput(raw: unknown): DecodedProposalInput {
  if (isRecord(raw)) {
    return {
      value: raw,
      diagnostics: [],
      appliedRules: ["direct_object"],
    };
  }

  if (typeof raw !== "string") {
    return {
      diagnostics: ["proposal.not_object"],
      appliedRules: [],
    };
  }

  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
  const jsonText = fenced?.[1] ?? trimmed;
  const appliedRules: ContinuationNormalizationRuleV1[] = [
    fenced === null ? "json_text" : "fenced_json",
  ];

  if (
    fenced === null &&
    (trimmed.includes("```") ||
      (!trimmed.startsWith("{") && /[{[]/u.test(trimmed)))
  ) {
    return {
      diagnostics: ["proposal.ambiguous_wrapper"],
      appliedRules,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      diagnostics: ["proposal.malformed_json"],
      appliedRules,
    };
  }

  if (!isRecord(parsed)) {
    return {
      diagnostics: ["proposal.not_object"],
      appliedRules,
    };
  }

  return {
    value: parsed,
    diagnostics: [],
    appliedRules,
  };
}

function normalizeStringFields(candidate: Record<string, unknown>): {
  readonly nextTask: string | undefined;
  readonly rationale: string | undefined;
  readonly trimmed: boolean;
} {
  const rawNextTask = candidate["nextTask"];
  const rawRationale = candidate["rationale"];
  const nextTask =
    typeof rawNextTask === "string" ? rawNextTask.trim() : undefined;
  const rationale =
    typeof rawRationale === "string" ? rawRationale.trim() : undefined;

  return {
    nextTask,
    rationale,
    trimmed:
      (typeof rawNextTask === "string" && rawNextTask !== nextTask) ||
      (typeof rawRationale === "string" && rawRationale !== rationale),
  };
}

function parseVerdict(value: unknown): ContinuationVerdictV1 | undefined {
  switch (value) {
    case "continue":
    case "complete":
    case "blocked":
      return value;
    default:
      return undefined;
  }
}

function validateNextTask(
  verdict: ContinuationVerdictV1 | undefined,
  nextTask: string | undefined,
  diagnostics: ContinuationDiagnosticCodeV1[]
): void {
  if (verdict === "continue") {
    if (nextTask === undefined || nextTask.length === 0) {
      diagnostics.push("proposal.next_task_required");
    } else if (nextTask.length > CONTINUATION_V1_MAX_NEXT_TASK_LENGTH) {
      diagnostics.push("proposal.next_task_too_long");
    }
    return;
  }

  if (
    (verdict === "complete" || verdict === "blocked") &&
    nextTask !== ""
  ) {
    diagnostics.push("proposal.next_task_must_be_empty");
  }
}

function validateRationale(
  rationale: string | undefined,
  diagnostics: ContinuationDiagnosticCodeV1[]
): void {
  if (rationale === undefined || rationale.length === 0) {
    diagnostics.push("proposal.rationale_required");
  } else if (rationale.length > CONTINUATION_V1_MAX_RATIONALE_LENGTH) {
    diagnostics.push("proposal.rationale_too_long");
  }
}

function validateEvidenceRefs(
  raw: unknown,
  diagnostics: ContinuationDiagnosticCodeV1[]
): {
  readonly refs: readonly string[] | undefined;
  readonly trimmed: boolean;
} {
  if (!Array.isArray(raw)) {
    diagnostics.push("proposal.evidence_refs_invalid");
    return { refs: undefined, trimmed: false };
  }

  if (raw.length > CONTINUATION_V1_MAX_EVIDENCE_REFS) {
    diagnostics.push("proposal.evidence_refs_limit_exceeded");
  }

  const normalized: string[] = [];
  let trimmed = false;
  for (const ref of raw) {
    if (typeof ref !== "string" || ref.trim().length === 0) {
      diagnostics.push("proposal.evidence_ref_invalid");
      continue;
    }

    const value = ref.trim();
    trimmed ||= value !== ref;
    if (value.length > CONTINUATION_V1_MAX_EVIDENCE_REF_LENGTH) {
      diagnostics.push("proposal.evidence_ref_too_long");
    }
    normalized.push(value);
  }

  if (new Set(normalized).size !== normalized.length) {
    diagnostics.push("proposal.evidence_ref_duplicate");
  }

  return {
    refs:
      diagnostics.length === 0 || normalized.length === raw.length
        ? normalized
        : undefined,
    trimmed,
  };
}

function buildProposal(
  verdict: ContinuationVerdictV1,
  nextTask: string | undefined,
  rationale: string | undefined,
  evidenceRefs: readonly string[]
): ContinuationProposalV1 {
  const shared = {
    schema: CONTINUATION_PROPOSAL_SCHEMA_V1,
    rationale: rationale ?? "",
    evidenceRefs,
  } as const;

  if (verdict === "continue") {
    return {
      ...shared,
      verdict,
      nextTask: nextTask ?? "",
    };
  }

  return {
    ...shared,
    verdict,
    nextTask: "",
  };
}

function invalidResult(
  appliedRules: readonly ContinuationNormalizationRuleV1[],
  diagnostics: readonly ContinuationDiagnosticCodeV1[]
): ContinuationNormalizationResultV1 {
  return {
    schema: "dzupagent/continuation-normalization/v1",
    status: "invalid",
    appliedRules: unique(appliedRules),
    diagnostics: unique(diagnostics),
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
