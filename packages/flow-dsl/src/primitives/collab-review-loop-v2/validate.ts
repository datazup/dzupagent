import {
  GIT_OBJECT_ID,
  IDENTIFIER,
  PROVIDERS,
  REVIEWER_CAPABILITIES,
  SHA256,
  STATE_KEY,
} from "./schema.js";
import {
  CollabReviewLoopV2Error,
  type EvidenceSources,
  type ImmutableIdentity,
  type ReviewLoopActor,
  type ReviewLoopSchemas,
  type ReviewLoopV2Input,
  type TerminalMapping,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertObject(
  value: unknown,
  path: string
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CollabReviewLoopV2Error(`${path} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new CollabReviewLoopV2Error(
      `${path} contains unsupported field ${unknown[0]}`
    );
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new CollabReviewLoopV2Error(`${path}.${key} is required`);
    }
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  pattern?: RegExp
): string {
  const candidate = value[key];
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    (pattern !== undefined && !pattern.test(candidate))
  ) {
    throw new CollabReviewLoopV2Error(`${path}.${key} is invalid`);
  }
  return candidate;
}

function assertIdentity(raw: unknown): asserts raw is ImmutableIdentity {
  assertObject(raw, "identity");
  assertExactKeys(
    raw,
    [
      "runId",
      "planId",
      "planHash",
      "taskId",
      "taskDefinitionHash",
      "repoId",
      "baseline",
    ],
    [
      "runId",
      "planId",
      "planHash",
      "taskId",
      "taskDefinitionHash",
      "repoId",
      "baseline",
    ],
    "identity"
  );
  for (const field of ["runId", "planId", "taskId", "repoId"]) {
    requiredString(raw, field, "identity", IDENTIFIER);
  }
  requiredString(raw, "planHash", "identity", SHA256);
  requiredString(raw, "taskDefinitionHash", "identity", SHA256);
  assertObject(raw.baseline, "identity.baseline");
  assertExactKeys(
    raw.baseline,
    ["commit", "tree"],
    ["commit", "tree"],
    "identity.baseline"
  );
  requiredString(raw.baseline, "commit", "identity.baseline", GIT_OBJECT_ID);
  requiredString(raw.baseline, "tree", "identity.baseline", GIT_OBJECT_ID);
}

function assertCapabilities(
  raw: unknown,
  path: string,
  allowed?: ReadonlySet<string>
): asserts raw is string[] {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every(
      (capability) =>
        typeof capability === "string" &&
        capability.length > 0 &&
        (allowed === undefined || allowed.has(capability))
    ) ||
    new Set(raw).size !== raw.length
  ) {
    throw new CollabReviewLoopV2Error(`${path} contains an invalid capability`);
  }
}

function assertActor(
  raw: unknown,
  role: "implementer" | "reviewer"
): asserts raw is ReviewLoopActor {
  assertObject(raw, role);
  assertExactKeys(
    raw,
    ["provider", "model", "persona", "instructions", "capabilities", "output"],
    ["provider", "persona", "instructions", "capabilities", "output"],
    role
  );
  const provider = requiredString(raw, "provider", role);
  if (!PROVIDERS.has(provider)) {
    throw new CollabReviewLoopV2Error(`${role}.provider is invalid`);
  }
  if (
    raw.model !== undefined &&
    (typeof raw.model !== "string" || raw.model.length === 0)
  ) {
    throw new CollabReviewLoopV2Error(`${role}.model is invalid`);
  }
  requiredString(raw, "persona", role, IDENTIFIER);
  requiredString(raw, "instructions", role);
  requiredString(raw, "output", role, STATE_KEY);
  assertCapabilities(
    raw.capabilities,
    `${role}.capabilities`,
    role === "reviewer" ? REVIEWER_CAPABILITIES : undefined
  );
}

function assertSchema(raw: unknown, path: string): void {
  if (typeof raw === "string" && raw.length > 0) return;
  if (isRecord(raw) && Object.keys(raw).length > 0) return;
  throw new CollabReviewLoopV2Error(`${path} must be a schema ref or object`);
}

function assertSchemas(raw: unknown): asserts raw is ReviewLoopSchemas {
  assertObject(raw, "schemas");
  assertExactKeys(
    raw,
    ["implementer", "reviewer"],
    ["implementer", "reviewer"],
    "schemas"
  );
  assertSchema(raw.implementer, "schemas.implementer");
  if (typeof raw.reviewer !== "string" || raw.reviewer.trim().length === 0) {
    throw new CollabReviewLoopV2Error(
      "schemas.reviewer must be a non-empty declarative schema reference; inline reviewer schemas are forbidden"
    );
  }
}

function assertEvidence(raw: unknown): asserts raw is EvidenceSources {
  assertObject(raw, "evidence");
  assertExactKeys(
    raw,
    ["diff", "validation"],
    ["diff", "validation"],
    "evidence"
  );
  requiredString(raw, "diff", "evidence");
  requiredString(raw, "validation", "evidence");
}

function assertTerminals(raw: unknown): asserts raw is TerminalMapping {
  assertObject(raw, "terminals");
  const fields = [
    "accepted",
    "blockedExternal",
    "rejectedScope",
    "rejectedCorrectness",
    "invalidReviewerVerdict",
  ] as const;
  assertExactKeys(raw, fields, fields, "terminals");
  const results = fields.map((field) =>
    requiredString(raw, field, "terminals")
  );
  if (new Set(results).size !== results.length) {
    throw new CollabReviewLoopV2Error("terminals results must be distinct");
  }
}

export function assertReviewLoopV2(
  raw: unknown
): asserts raw is ReviewLoopV2Input {
  assertObject(raw, "input");
  assertExactKeys(
    raw,
    [
      "id",
      "identity",
      "implementer",
      "reviewer",
      "schemas",
      "evidence",
      "validationRef",
      "reconcile",
      "terminals",
    ],
    [
      "id",
      "identity",
      "implementer",
      "reviewer",
      "schemas",
      "evidence",
      "validationRef",
      "reconcile",
      "terminals",
    ],
    "input"
  );
  requiredString(raw, "id", "input", STATE_KEY);
  assertIdentity(raw.identity);
  assertActor(raw.implementer, "implementer");
  assertActor(raw.reviewer, "reviewer");
  assertSchemas(raw.schemas);
  assertEvidence(raw.evidence);
  requiredString(raw, "validationRef", "input", IDENTIFIER);
  assertObject(raw.reconcile, "reconcile");
  assertExactKeys(raw.reconcile, ["maxRevise"], ["maxRevise"], "reconcile");
  if (
    !Number.isInteger(raw.reconcile.maxRevise) ||
    (raw.reconcile.maxRevise as number) < 1 ||
    (raw.reconcile.maxRevise as number) > 2
  ) {
    throw new CollabReviewLoopV2Error(
      "reconcile.maxRevise must be an integer between 1 and 2"
    );
  }
  assertTerminals(raw.terminals);

  const generatedOutputs = [
    raw.implementer.output,
    raw.reviewer.output,
    `${raw.id}_candidate_evidence`,
    `${raw.id}_reviewer_schema_validation`,
  ];
  if (new Set(generatedOutputs).size !== generatedOutputs.length) {
    throw new CollabReviewLoopV2Error("output keys must be unique");
  }
}
