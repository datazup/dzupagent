import type { PrimitiveExpansionContext } from "./types.js";
import { COLLAB_REVIEW_LOOP_V2_SCHEMA } from "./collab-review-loop-v2/schema.js";
import { CollabReviewLoopV2Error } from "./collab-review-loop-v2/types.js";
import { assertReviewLoopV2 } from "./collab-review-loop-v2/validate.js";

export { COLLAB_REVIEW_LOOP_V2_SCHEMA, CollabReviewLoopV2Error };

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
  }
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
    elseSteps: Array<Record<string, unknown>>
  ): Record<string, unknown> => ({
    if: {
      id: `${raw.id}__${id}`,
      condition: verdictCondition(raw.reviewer.output, verdict),
      then: thenSteps,
      else: elseSteps,
      meta,
    },
  });

  const terminalBranch = branch(
    "accept_verdict",
    "accept",
    [complete("accepted", raw.terminals.accepted)],
    [
      branch(
        "revise_verdict",
        "revise",
        [
          {
            return_to: {
              id: `${raw.id}__revise`,
              targetId: implementerId,
              condition: verdictCondition(raw.reviewer.output, "revise"),
              maxIterations: raw.reconcile.maxRevise,
              meta,
            },
          },
        ],
        [
          branch(
            "blocked_verdict",
            "blocked_external",
            [complete("blocked_external", raw.terminals.blockedExternal)],
            [
              branch(
                "scope_verdict",
                "reject_scope",
                [complete("rejected_scope", raw.terminals.rejectedScope)],
                [
                  branch(
                    "correctness_verdict",
                    "reject_correctness",
                    [
                      complete(
                        "rejected_correctness",
                        raw.terminals.rejectedCorrectness
                      ),
                    ],
                    [
                      complete(
                        "invalid_reviewer_verdict",
                        raw.terminals.invalidReviewerVerdict
                      ),
                    ]
                  ),
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );

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
