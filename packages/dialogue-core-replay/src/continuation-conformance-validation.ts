import {
  CONTINUATION_DIAGNOSTIC_CODES_V1,
  CONTINUATION_POLICY_SCHEMA_V1,
  CONTINUATION_PROPOSAL_SCHEMA_V1,
  CONTINUATION_TRANSITION_SCHEMA_V1,
  canonicalizeContinuationValueV1,
  evaluateContinuationTransitionV1,
  type ContinuationDiagnosticCodeV1,
  type ContinuationNormalizationResultV1,
} from "@dzupagent/dialogue-core/continuation/v1";

import {
  CONTINUATION_CONFORMANCE_FIXTURE_SET_SCHEMA_V1,
  CONTINUATION_DIVERGENCE_LEDGER_SCHEMA_V1,
  type ContinuationConformanceFixtureSetV1,
} from "./continuation-conformance.js";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const FAMILIES = new Set([
  "scripts_historical",
  "codev",
  "adversarial",
]);
const COMPARISON_CLASSIFICATIONS = new Set([
  "match",
  "safer_kernel",
  "reviewed_difference",
]);
const LEGACY_DECISIONS = new Set([
  "continue",
  "complete",
  "blocked",
  "judge_required",
  "genuine_blocker",
  "non_semantic_blocker",
  "unclassified",
]);
const LEGACY_TRANSITIONS = new Set([
  "continue",
  "complete",
  "blocked",
  "review_again",
  "reject",
  "host_stop",
  "suspend",
]);
const NORMALIZATION_RULES = new Set([
  "direct_object",
  "json_text",
  "fenced_json",
  "trim_strings",
]);
const DIAGNOSTIC_CODES = new Set<string>(
  CONTINUATION_DIAGNOSTIC_CODES_V1
);

export class ContinuationConformanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuationConformanceValidationError";
  }
}

export function loadContinuationConformanceFixtureSetV1(
  json: string
): ContinuationConformanceFixtureSetV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ContinuationConformanceValidationError(
      `Continuation fixture JSON parse error: ${String(error)}`
    );
  }

  return validateContinuationConformanceFixtureSetV1(parsed);
}

export function validateContinuationConformanceFixtureSetV1(
  value: unknown
): ContinuationConformanceFixtureSetV1 {
  try {
    canonicalizeContinuationValueV1(value);
  } catch (error) {
    fail(`fixture set must be JSON-safe: ${String(error)}`);
  }

  const fixture = requireRecord(value, "fixture set");
  exactKeys(
    fixture,
    [
      "schema",
      "fixtureSetId",
      "contractVersion",
      "sources",
      "cases",
      "divergenceLedger",
      "publicationReview",
    ],
    "fixture set"
  );
  requireEqual(
    fixture["schema"],
    CONTINUATION_CONFORMANCE_FIXTURE_SET_SCHEMA_V1,
    "fixture set schema"
  );
  nonEmptyString(fixture["fixtureSetId"], "fixtureSetId");
  requireEqual(
    fixture["contractVersion"],
    "continuation/v1",
    "contractVersion"
  );

  const sources = requireArray(fixture["sources"], "sources");
  if (sources.length === 0) {
    fail("sources must contain at least one entry");
  }
  const sourceIds = new Set<string>();
  const sourceFamilies = new Map<string, string>();
  const declaredSourceCounts = new Map<string, number>();
  for (const [index, sourceValue] of sources.entries()) {
    const source = requireRecord(sourceValue, `sources[${index}]`);
    exactKeys(
      source,
      [
        "sourceId",
        "family",
        "sourceSchema",
        "sourceDigest",
        "sourceByteDigest",
        "sourceCaseCount",
        "reductionProcedureVersion",
      ],
      `sources[${index}]`,
      ["sourceByteDigest"]
    );
    const sourceId = nonEmptyString(
      source["sourceId"],
      `sources[${index}].sourceId`
    );
    if (sourceIds.has(sourceId)) {
      fail(`duplicate sourceId: ${sourceId}`);
    }
    sourceIds.add(sourceId);
    const family = enumValue(
      source["family"],
      FAMILIES,
      `sources[${index}].family`
    );
    sourceFamilies.set(sourceId, family);
    nonEmptyString(
      source["sourceSchema"],
      `sources[${index}].sourceSchema`
    );
    hashValue(source["sourceDigest"], `sources[${index}].sourceDigest`);
    if (source["sourceByteDigest"] !== undefined) {
      hashValue(
        source["sourceByteDigest"],
        `sources[${index}].sourceByteDigest`
      );
    }
    const sourceCaseCount = positiveInteger(
      source["sourceCaseCount"],
      `sources[${index}].sourceCaseCount`
    );
    declaredSourceCounts.set(sourceId, sourceCaseCount);
    nonEmptyString(
      source["reductionProcedureVersion"],
      `sources[${index}].reductionProcedureVersion`
    );
  }
  requireSorted(
    sources.map((source) => (source as Record<string, unknown>)["sourceId"]),
    "sources"
  );

  const cases = requireArray(fixture["cases"], "cases");
  if (cases.length === 0) {
    fail("cases must contain at least one entry");
  }
  const caseIds = new Set<string>();
  const actualSourceCounts = new Map<string, number>();
  const classificationsByCase = new Map<string, string>();
  for (const [index, caseValue] of cases.entries()) {
    const item = requireRecord(caseValue, `cases[${index}]`);
    exactKeys(
      item,
      [
        "caseId",
        "family",
        "sourceId",
        "description",
        "input",
        "expected",
      ],
      `cases[${index}]`
    );
    const caseId = nonEmptyString(
      item["caseId"],
      `cases[${index}].caseId`
    );
    if (caseIds.has(caseId)) {
      fail(`duplicate caseId: ${caseId}`);
    }
    caseIds.add(caseId);
    const family = enumValue(
      item["family"],
      FAMILIES,
      `cases[${index}].family`
    );
    const sourceId = nonEmptyString(
      item["sourceId"],
      `cases[${index}].sourceId`
    );
    if (!sourceIds.has(sourceId)) {
      fail(`case ${caseId} references unknown sourceId ${sourceId}`);
    }
    if (sourceFamilies.get(sourceId) !== family) {
      fail(`case ${caseId} family does not match source ${sourceId}`);
    }
    actualSourceCounts.set(
      sourceId,
      (actualSourceCounts.get(sourceId) ?? 0) + 1
    );
    nonEmptyString(
      item["description"],
      `cases[${index}].description`
    );

    const input = requireRecord(item["input"], `case ${caseId} input`);
    exactKeys(
      input,
      ["proposal", "evidence", "policy", "hostControl"],
      `case ${caseId} input`
    );
    validateNormalizationResult(
      input["proposal"],
      `case ${caseId} proposal`
    );
    validateKernelInputs(input, caseId);

    const expected = requireRecord(
      item["expected"],
      `case ${caseId} expected`
    );
    exactKeys(
      expected,
      ["kernelTransition", "comparisonClassification", "legacy"],
      `case ${caseId} expected`,
      ["legacy"]
    );
    validateTransition(
      expected["kernelTransition"],
      `case ${caseId} expected.kernelTransition`
    );
    const classification = enumValue(
      expected["comparisonClassification"],
      COMPARISON_CLASSIFICATIONS,
      `case ${caseId} comparisonClassification`
    );
    classificationsByCase.set(caseId, classification);
    if (expected["legacy"] !== undefined) {
      validateLegacyObservation(expected["legacy"], caseId);
    }
  }
  requireSorted(
    cases.map((item) => (item as Record<string, unknown>)["caseId"]),
    "cases"
  );

  for (const sourceId of sourceIds) {
    if (
      actualSourceCounts.get(sourceId) !==
      declaredSourceCounts.get(sourceId)
    ) {
      fail(
        `source ${sourceId} case count does not match its declaration`
      );
    }
  }

  const ledger = requireArray(
    fixture["divergenceLedger"],
    "divergenceLedger"
  );
  const ledgerCaseIds = new Set<string>();
  for (const [index, entryValue] of ledger.entries()) {
    const entry = requireRecord(
      entryValue,
      `divergenceLedger[${index}]`
    );
    exactKeys(
      entry,
      [
        "schema",
        "caseId",
        "classification",
        "legacySummary",
        "kernelSummary",
        "safetyRationale",
        "reviewStatus",
        "reviewedBy",
        "reviewedAt",
      ],
      `divergenceLedger[${index}]`
    );
    requireEqual(
      entry["schema"],
      CONTINUATION_DIVERGENCE_LEDGER_SCHEMA_V1,
      `divergenceLedger[${index}].schema`
    );
    const caseId = nonEmptyString(
      entry["caseId"],
      `divergenceLedger[${index}].caseId`
    );
    if (!caseIds.has(caseId)) {
      fail(`divergence ledger references unknown case ${caseId}`);
    }
    if (ledgerCaseIds.has(caseId)) {
      fail(`duplicate divergence ledger case ${caseId}`);
    }
    ledgerCaseIds.add(caseId);
    const classification = enumValue(
      entry["classification"],
      new Set(["safer_kernel", "reviewed_difference"]),
      `divergenceLedger[${index}].classification`
    );
    if (classificationsByCase.get(caseId) !== classification) {
      fail(`divergence ledger classification mismatch for ${caseId}`);
    }
    nonEmptyString(
      entry["legacySummary"],
      `divergenceLedger[${index}].legacySummary`
    );
    nonEmptyString(
      entry["kernelSummary"],
      `divergenceLedger[${index}].kernelSummary`
    );
    nonEmptyString(
      entry["safetyRationale"],
      `divergenceLedger[${index}].safetyRationale`
    );
    enumValue(
      entry["reviewStatus"],
      new Set(["proposed", "approved"]),
      `divergenceLedger[${index}].reviewStatus`
    );
    nonEmptyString(
      entry["reviewedBy"],
      `divergenceLedger[${index}].reviewedBy`
    );
    isoDate(entry["reviewedAt"], `divergenceLedger[${index}].reviewedAt`);
  }
  requireSorted(
    ledger.map((entry) => (entry as Record<string, unknown>)["caseId"]),
    "divergenceLedger"
  );

  for (const [caseId, classification] of classificationsByCase) {
    if (
      (classification === "safer_kernel" ||
        classification === "reviewed_difference") &&
      !ledgerCaseIds.has(caseId)
    ) {
      fail(`case ${caseId} requires a divergence ledger entry`);
    }
  }

  validatePublicationReview(fixture["publicationReview"]);

  return value as ContinuationConformanceFixtureSetV1;
}

function validateNormalizationResult(
  value: unknown,
  label: string
): asserts value is ContinuationNormalizationResultV1 {
  const result = requireRecord(value, label);
  const status = enumValue(
    result["status"],
    new Set(["valid", "invalid"]),
    `${label}.status`
  );
  exactKeys(
    result,
    ["schema", "status", "proposal", "appliedRules", "diagnostics"],
    label,
    status === "invalid" ? ["proposal"] : []
  );
  requireEqual(
    result["schema"],
    "dzupagent/continuation-normalization/v1",
    `${label}.schema`
  );
  stringArray(result["appliedRules"], `${label}.appliedRules`).forEach(
    (rule) => {
      if (!NORMALIZATION_RULES.has(rule)) {
        fail(`${label} contains unknown normalization rule ${rule}`);
      }
    }
  );
  diagnosticArray(result["diagnostics"], `${label}.diagnostics`);

  if (status === "invalid") {
    if (result["proposal"] !== undefined) {
      fail(`${label} invalid result must not contain proposal`);
    }
    if ((result["diagnostics"] as unknown[]).length === 0) {
      fail(`${label} invalid result requires diagnostics`);
    }
    return;
  }

  const proposal = requireRecord(result["proposal"], `${label}.proposal`);
  exactKeys(
    proposal,
    ["schema", "verdict", "nextTask", "rationale", "evidenceRefs"],
    `${label}.proposal`
  );
  requireEqual(
    proposal["schema"],
    CONTINUATION_PROPOSAL_SCHEMA_V1,
    `${label}.proposal.schema`
  );
  const verdict = enumValue(
    proposal["verdict"],
    new Set(["continue", "complete", "blocked"]),
    `${label}.proposal.verdict`
  );
  const nextTask = stringValue(
    proposal["nextTask"],
    `${label}.proposal.nextTask`
  );
  if (verdict === "continue" && nextTask.trim().length === 0) {
    fail(`${label} continue proposal requires nextTask`);
  }
  if (verdict !== "continue" && nextTask !== "") {
    fail(`${label} terminal proposal requires empty nextTask`);
  }
  nonEmptyString(
    proposal["rationale"],
    `${label}.proposal.rationale`
  );
  stringArray(
    proposal["evidenceRefs"],
    `${label}.proposal.evidenceRefs`
  );
}

function validateKernelInputs(
  input: Record<string, unknown>,
  caseId: string
): void {
  const probeProposal = {
    schema: "dzupagent/continuation-normalization/v1",
    status: "valid",
    proposal: {
      schema: CONTINUATION_PROPOSAL_SCHEMA_V1,
      verdict: "continue",
      nextTask: "Validate the fixture contract.",
      rationale: "Runtime input validation probe.",
      evidenceRefs: [],
    },
    appliedRules: ["direct_object"],
    diagnostics: [],
  } as const;
  const runControl = { action: "run" } as const;

  const evidenceProbe = evaluateContinuationTransitionV1({
    proposal: probeProposal,
    evidence: input["evidence"] as never,
    policy: {
      schema: CONTINUATION_POLICY_SCHEMA_V1,
      terminalBlocked: "allow",
      completionValidation: "passed_or_not_required",
      repeatedTask: {
        maxPriorOccurrences: 1,
        onLimit: "review_again",
      },
    },
    hostControl: runControl,
  });
  if (
    evidenceProbe.action === "reject" &&
    evidenceProbe.reason === "invalid_evidence"
  ) {
    fail(`case ${caseId} has invalid continuation evidence`);
  }

  const policyProbe = evaluateContinuationTransitionV1({
    proposal: probeProposal,
    evidence: input["evidence"] as never,
    policy: input["policy"] as never,
    hostControl: runControl,
  });
  if (
    policyProbe.action === "reject" &&
    policyProbe.reason === "invalid_policy"
  ) {
    fail(`case ${caseId} has invalid continuation policy`);
  }

  const controlProbe = evaluateContinuationTransitionV1({
    proposal: input["proposal"] as never,
    evidence: input["evidence"] as never,
    policy: input["policy"] as never,
    hostControl: input["hostControl"] as never,
  });
  if (
    controlProbe.action === "reject" &&
    controlProbe.reason === "invalid_host_control"
  ) {
    fail(`case ${caseId} has invalid host control`);
  }
}

function validateTransition(value: unknown, label: string): void {
  const transition = requireRecord(value, label);
  requireEqual(
    transition["schema"],
    CONTINUATION_TRANSITION_SCHEMA_V1,
    `${label}.schema`
  );
  const action = enumValue(
    transition["action"],
    new Set(["continue", "stop", "suspend", "review_again", "reject"]),
    `${label}.action`
  );
  diagnosticArray(transition["diagnostics"], `${label}.diagnostics`);
  if (action === "continue") {
    exactKeys(
      transition,
      ["schema", "action", "nextTask", "taskKey", "diagnostics"],
      label
    );
    nonEmptyString(transition["nextTask"], `${label}.nextTask`);
    if (
      typeof transition["taskKey"] !== "string" ||
      !/^task-key\/v1:sha256:[a-f0-9]{64}$/u.test(
        transition["taskKey"]
      )
    ) {
      fail(`${label}.taskKey must be a v1 SHA-256 task key`);
    }
    return;
  }

  if (action === "stop") {
    exactKeys(
      transition,
      ["schema", "action", "reason", "blockerCodes", "diagnostics"],
      label,
      ["blockerCodes"]
    );
    nonEmptyString(transition["reason"], `${label}.reason`);
    if (transition["blockerCodes"] !== undefined) {
      stringArray(
        transition["blockerCodes"],
        `${label}.blockerCodes`
      );
    }
    return;
  }

  if (action === "suspend" || action === "reject") {
    exactKeys(
      transition,
      ["schema", "action", "reason", "diagnostics"],
      label
    );
    nonEmptyString(transition["reason"], `${label}.reason`);
    return;
  }

  exactKeys(
    transition,
    ["schema", "action", "reason", "blockerCodes", "diagnostics"],
    label,
    ["blockerCodes"]
  );
  nonEmptyString(transition["reason"], `${label}.reason`);
  if (transition["blockerCodes"] !== undefined) {
    stringArray(transition["blockerCodes"], `${label}.blockerCodes`);
  }
}

function validateLegacyObservation(value: unknown, caseId: string): void {
  const legacy = requireRecord(value, `case ${caseId} legacy`);
  exactKeys(
    legacy,
    ["normalizedDecision", "admittedTransition", "diagnosticCodes"],
    `case ${caseId} legacy`
  );
  enumValue(
    legacy["normalizedDecision"],
    LEGACY_DECISIONS,
    `case ${caseId} legacy.normalizedDecision`
  );
  enumValue(
    legacy["admittedTransition"],
    LEGACY_TRANSITIONS,
    `case ${caseId} legacy.admittedTransition`
  );
  stringArray(
    legacy["diagnosticCodes"],
    `case ${caseId} legacy.diagnosticCodes`
  );
}

function validatePublicationReview(value: unknown): void {
  const review = requireRecord(value, "publicationReview");
  exactKeys(
    review,
    [
      "reviewStatus",
      "reviewedBy",
      "reviewedAt",
      "containsRawProviderOutput",
      "containsAbsolutePaths",
      "containsTenantContent",
      "containsCredentials",
    ],
    "publicationReview"
  );
  enumValue(
    review["reviewStatus"],
    new Set(["automated", "approved"]),
    "publicationReview.reviewStatus"
  );
  nonEmptyString(review["reviewedBy"], "publicationReview.reviewedBy");
  isoDate(review["reviewedAt"], "publicationReview.reviewedAt");
  for (const field of [
    "containsRawProviderOutput",
    "containsAbsolutePaths",
    "containsTenantContent",
    "containsCredentials",
  ]) {
    if (review[field] !== false) {
      fail(`publicationReview.${field} must be false`);
    }
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = []
): void {
  const actual = Object.keys(value).sort();
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  const required = allowed.filter((key) => !optionalSet.has(key));
  const unknown = actual.filter((key) => !allowedSet.has(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      `${label} keys invalid; missing=${missing.join(",") || "none"} unknown=${unknown.join(",") || "none"}`
    );
  }
}

function requireRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  const array = requireArray(value, label);
  if (!array.every((item) => typeof item === "string")) {
    fail(`${label} must contain strings only`);
  }
  return array as string[];
}

function diagnosticArray(
  value: unknown,
  label: string
): ContinuationDiagnosticCodeV1[] {
  const array = stringArray(value, label);
  for (const diagnostic of array) {
    if (!DIAGNOSTIC_CODES.has(diagnostic)) {
      fail(`${label} contains unknown diagnostic ${diagnostic}`);
    }
  }
  return array as ContinuationDiagnosticCodeV1[];
}

function nonEmptyString(value: unknown, label: string): string {
  const string = stringValue(value, label);
  if (string.trim().length === 0) {
    fail(`${label} must be non-empty`);
  }
  return string;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail(`${label} must be a string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return Number(value);
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail(`${label} must be a sha256: prefixed digest`);
  }
  return value;
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail(`${label} must be an ISO UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail(`${label} must be an ISO UTC timestamp`);
  }
  const canonical = new Date(parsed).toISOString();
  if (value !== canonical && value !== canonical.replace(".000Z", "Z")) {
    fail(`${label} must be an ISO UTC timestamp`);
  }
  return value;
}

function enumValue(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string
): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail(`${label} has an unsupported value`);
  }
  return value;
}

function requireEqual(
  actual: unknown,
  expected: unknown,
  label: string
): void {
  if (actual !== expected) {
    fail(`${label} must be ${String(expected)}`);
  }
}

function requireSorted(values: readonly unknown[], label: string): void {
  const strings = values.map((value, index) =>
    nonEmptyString(value, `${label}[${index}] identity`)
  );
  const sorted = [...strings].sort();
  if (JSON.stringify(strings) !== JSON.stringify(sorted)) {
    fail(`${label} must be sorted by stable identity`);
  }
}

function fail(message: string): never {
  throw new ContinuationConformanceValidationError(message);
}
