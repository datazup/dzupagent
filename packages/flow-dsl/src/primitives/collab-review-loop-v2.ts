import type { PrimitiveExpansionContext } from "./types.js";

export class CollabReviewLoopV2Error extends Error {
  constructor(message: string) {
    super(`collab.review_loop@2: ${message}`);
    this.name = "CollabReviewLoopV2Error";
  }
}

interface ImmutableIdentity {
  runId: string;
  planId: string;
  planHash: string;
  taskId: string;
  taskDefinitionHash: string;
  repoId: string;
  baseline: {
    commit: string;
    tree: string;
  };
}

interface ReviewLoopActor {
  provider: string;
  model?: string;
  persona: string;
  instructions: string;
  capabilities: string[];
  output: string;
}

interface ReviewLoopSchemas {
  implementer: string | Record<string, unknown>;
  reviewer: string;
}

interface EvidenceSources {
  diff: string;
  validation: string;
}

interface TerminalMapping {
  accepted: string;
  blockedExternal: string;
  rejectedScope: string;
  rejectedCorrectness: string;
  invalidReviewerVerdict: string;
}

interface ReviewLoopV2Input {
  id: string;
  identity: ImmutableIdentity;
  implementer: ReviewLoopActor;
  reviewer: ReviewLoopActor;
  schemas: ReviewLoopSchemas;
  evidence: EvidenceSources;
  validationRef: string;
  reconcile: { maxRevise: number };
  terminals: TerminalMapping;
}

const PROVIDER_NAMES = [
  "claude",
  "codex",
  "gemini",
  "openai",
  "openrouter",
  "openrouter-crush",
  "qwen",
  "goose",
  "crush",
] as const;
const PROVIDERS = new Set<string>(PROVIDER_NAMES);

const REVIEWER_CAPABILITY_NAMES = [
  "plan.get",
  "task.get",
  "repo.snapshot",
  "diff.read",
  "validation.results",
  "docs.readSections",
  "run.status",
  "evidence.get",
] as const;
const REVIEWER_CAPABILITIES = new Set<string>(REVIEWER_CAPABILITY_NAMES);

const STATE_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/;

const SCHEMA_VALUE = {
  anyOf: [
    { type: "string", minLength: 1 },
    { type: "object", minProperties: 1 },
  ],
};

const ACTOR_REQUIRED = [
  "provider",
  "persona",
  "instructions",
  "capabilities",
  "output",
];

function actorInputSchema(
  capabilities: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ACTOR_REQUIRED,
    properties: {
      provider: { enum: [...PROVIDER_NAMES] },
      model: { type: "string", minLength: 1 },
      persona: { type: "string", pattern: IDENTIFIER.source },
      instructions: { type: "string", minLength: 1 },
      capabilities,
      output: { type: "string", pattern: STATE_KEY.source },
    },
  };
}

export const COLLAB_REVIEW_LOOP_V2_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
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
  properties: {
    id: { type: "string", pattern: STATE_KEY.source },
    identity: {
      type: "object",
      additionalProperties: false,
      required: [
        "runId",
        "planId",
        "planHash",
        "taskId",
        "taskDefinitionHash",
        "repoId",
        "baseline",
      ],
      properties: {
        runId: { type: "string", pattern: IDENTIFIER.source },
        planId: { type: "string", pattern: IDENTIFIER.source },
        planHash: { type: "string", pattern: SHA256.source },
        taskId: { type: "string", pattern: IDENTIFIER.source },
        taskDefinitionHash: { type: "string", pattern: SHA256.source },
        repoId: { type: "string", pattern: IDENTIFIER.source },
        baseline: {
          type: "object",
          additionalProperties: false,
          required: ["commit", "tree"],
          properties: {
            commit: { type: "string", pattern: GIT_OBJECT_ID.source },
            tree: { type: "string", pattern: GIT_OBJECT_ID.source },
          },
        },
      },
    },
    implementer: actorInputSchema({
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    }),
    reviewer: actorInputSchema({
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: [...REVIEWER_CAPABILITY_NAMES] },
    }),
    schemas: {
      type: "object",
      additionalProperties: false,
      required: ["implementer", "reviewer"],
      properties: {
        implementer: SCHEMA_VALUE,
        reviewer: { type: "string", minLength: 1, pattern: "\\S" },
      },
    },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["diff", "validation"],
      properties: {
        diff: { type: "string", minLength: 1 },
        validation: { type: "string", minLength: 1 },
      },
    },
    validationRef: { type: "string", pattern: IDENTIFIER.source },
    reconcile: {
      type: "object",
      additionalProperties: false,
      required: ["maxRevise"],
      properties: {
        maxRevise: { type: "integer", minimum: 1, maximum: 2 },
      },
    },
    terminals: {
      type: "object",
      additionalProperties: false,
      required: [
        "accepted",
        "blockedExternal",
        "rejectedScope",
        "rejectedCorrectness",
        "invalidReviewerVerdict",
      ],
      properties: Object.fromEntries(
        [
          "accepted",
          "blockedExternal",
          "rejectedScope",
          "rejectedCorrectness",
          "invalidReviewerVerdict",
        ].map((field) => [field, { type: "string", minLength: 1 }]),
      ),
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertObject(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CollabReviewLoopV2Error(`${path} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new CollabReviewLoopV2Error(
      `${path} contains unsupported field ${unknown[0]}`,
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
  pattern?: RegExp,
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
    "identity",
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
    "identity.baseline",
  );
  requiredString(raw.baseline, "commit", "identity.baseline", GIT_OBJECT_ID);
  requiredString(raw.baseline, "tree", "identity.baseline", GIT_OBJECT_ID);
}

function assertCapabilities(
  raw: unknown,
  path: string,
  allowed?: ReadonlySet<string>,
): asserts raw is string[] {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((capability) =>
      typeof capability === "string" &&
      capability.length > 0 &&
      (allowed === undefined || allowed.has(capability)),
    ) ||
    new Set(raw).size !== raw.length
  ) {
    throw new CollabReviewLoopV2Error(`${path} contains an invalid capability`);
  }
}

function assertActor(
  raw: unknown,
  role: "implementer" | "reviewer",
): asserts raw is ReviewLoopActor {
  assertObject(raw, role);
  assertExactKeys(
    raw,
    ["provider", "model", "persona", "instructions", "capabilities", "output"],
    ["provider", "persona", "instructions", "capabilities", "output"],
    role,
  );
  const provider = requiredString(raw, "provider", role);
  if (!PROVIDERS.has(provider)) {
    throw new CollabReviewLoopV2Error(`${role}.provider is invalid`);
  }
  if (raw.model !== undefined && (typeof raw.model !== "string" || raw.model.length === 0)) {
    throw new CollabReviewLoopV2Error(`${role}.model is invalid`);
  }
  requiredString(raw, "persona", role, IDENTIFIER);
  requiredString(raw, "instructions", role);
  requiredString(raw, "output", role, STATE_KEY);
  assertCapabilities(
    raw.capabilities,
    `${role}.capabilities`,
    role === "reviewer" ? REVIEWER_CAPABILITIES : undefined,
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
    "schemas",
  );
  assertSchema(raw.implementer, "schemas.implementer");
  if (typeof raw.reviewer !== "string" || raw.reviewer.trim().length === 0) {
    throw new CollabReviewLoopV2Error(
      "schemas.reviewer must be a non-empty declarative schema reference; inline reviewer schemas are forbidden",
    );
  }
}

function assertEvidence(raw: unknown): asserts raw is EvidenceSources {
  assertObject(raw, "evidence");
  assertExactKeys(raw, ["diff", "validation"], ["diff", "validation"], "evidence");
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
  const results = fields.map((field) => requiredString(raw, field, "terminals"));
  if (new Set(results).size !== results.length) {
    throw new CollabReviewLoopV2Error("terminals results must be distinct");
  }
}

function assertReviewLoopV2(raw: unknown): asserts raw is ReviewLoopV2Input {
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
    "input",
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
      "reconcile.maxRevise must be an integer between 1 and 2",
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

function stateValue(output: string): string {
  return `{{ state.${output} }}`;
}

function verdictCondition(output: string, verdict: string): string {
  return `state.${output}.verdict === '${verdict}'`;
}

export function expandCollabReviewLoopV2(
  raw: unknown,
  context: PrimitiveExpansionContext = {
    kind: "collab.review_loop",
    version: "2",
  },
): Array<Record<string, unknown>> {
  assertReviewLoopV2(raw);
  const primitive = `${context.kind}@${context.version}`;
  const meta = { collabExpansion: raw.id, primitive };
  const implementerId = `${raw.id}__implement`;
  const candidateEvidenceOutput = `${raw.id}_candidate_evidence`;
  const reviewerSchemaOutput = `${raw.id}_reviewer_schema_validation`;

  const complete = (id: string, result: string): Record<string, unknown> => ({
    complete: { id: `${raw.id}__${id}`, result, meta },
  });
  const branch = (
    id: string,
    verdict: string,
    thenSteps: Array<Record<string, unknown>>,
    elseSteps: Array<Record<string, unknown>>,
  ): Record<string, unknown> => ({
    if: {
      id: `${raw.id}__${id}`,
      condition: verdictCondition(raw.reviewer.output, verdict),
      then: thenSteps,
      else: elseSteps,
      meta,
    },
  });

  const terminalBranch = branch("accept_verdict", "accept", [
    complete("accepted", raw.terminals.accepted),
  ], [
    branch("revise_verdict", "revise", [
      {
        return_to: {
          id: `${raw.id}__revise`,
          targetId: implementerId,
          condition: verdictCondition(raw.reviewer.output, "revise"),
          maxIterations: raw.reconcile.maxRevise,
          meta,
        },
      },
    ], [
      branch("blocked_verdict", "blocked_external", [
        complete("blocked_external", raw.terminals.blockedExternal),
      ], [
        branch("scope_verdict", "reject_scope", [
          complete("rejected_scope", raw.terminals.rejectedScope),
        ], [
          branch("correctness_verdict", "reject_correctness", [
            complete("rejected_correctness", raw.terminals.rejectedCorrectness),
          ], [
            complete(
              "invalid_reviewer_verdict",
              raw.terminals.invalidReviewerVerdict,
            ),
          ]),
        ]),
      ]),
    ]),
  ]);

  return [
    {
      "adapter.run": {
        id: implementerId,
        provider: raw.implementer.provider,
        ...(raw.implementer.model ? { model: raw.implementer.model } : {}),
        persona: raw.implementer.persona,
        instructions: raw.implementer.instructions,
        input: {
          identity: raw.identity,
          capabilities: [...raw.implementer.capabilities],
        },
        outputSchema: raw.schemas.implementer,
        policy: { capabilities: [...raw.implementer.capabilities] },
        output: raw.implementer.output,
        meta,
      },
    },
    {
      "evidence.write": {
        id: `${raw.id}__candidate_evidence`,
        source: stateValue(raw.implementer.output),
        output: candidateEvidenceOutput,
        redact: true,
        meta,
      },
    },
    {
      validate: {
        id: `${raw.id}__validation`,
        ref: raw.validationRef,
        meta,
      },
    },
    {
      "adapter.run": {
        id: `${raw.id}__review`,
        provider: raw.reviewer.provider,
        ...(raw.reviewer.model ? { model: raw.reviewer.model } : {}),
        persona: raw.reviewer.persona,
        instructions: raw.reviewer.instructions,
        input: {
          identity: raw.identity,
          evidence: {
            candidate: stateValue(candidateEvidenceOutput),
            diff: raw.evidence.diff,
            validation: raw.evidence.validation,
          },
          capabilities: [...raw.reviewer.capabilities],
        },
        outputSchema: raw.schemas.reviewer,
        policy: {
          readOnly: true,
          capabilities: [...raw.reviewer.capabilities],
        },
        output: raw.reviewer.output,
        meta,
      },
    },
    {
      "validate.schema": {
        id: `${raw.id}__reviewer_schema`,
        source: stateValue(raw.reviewer.output),
        schema: raw.schemas.reviewer,
        output: reviewerSchemaOutput,
        meta,
      },
    },
    terminalBranch,
  ];
}
