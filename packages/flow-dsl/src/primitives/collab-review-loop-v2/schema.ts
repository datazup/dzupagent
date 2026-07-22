export const PROVIDER_NAMES = [
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
export const PROVIDERS = new Set<string>(PROVIDER_NAMES);

export const REVIEWER_CAPABILITY_NAMES = [
  "plan.get",
  "task.get",
  "repo.snapshot",
  "diff.read",
  "validation.results",
  "docs.readSections",
  "run.status",
  "evidence.get",
] as const;
export const REVIEWER_CAPABILITIES = new Set<string>(REVIEWER_CAPABILITY_NAMES);

export const STATE_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
export const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]*$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const GIT_OBJECT_ID = /^[a-f0-9]{40}$/;

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
  capabilities: Record<string, unknown>
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
        ].map((field) => [field, { type: "string", minLength: 1 }])
      ),
    },
  },
};
