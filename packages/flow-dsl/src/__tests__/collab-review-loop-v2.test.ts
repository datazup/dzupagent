import {
  checkOutputKeyUniqueness,
  resolveFlowConditionExpression,
  resolveFlowTemplateExpression,
  type FlowNode,
} from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import { parseDslToDocument } from "../parse-dsl.js";
import { validateDocument } from "../document-validate.js";
import {
  BUILT_IN_PRIMITIVES,
  expandCollabReviewLoopV2,
  exportPrimitiveCatalog,
} from "../primitives/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const COMMIT_C = "c".repeat(40);
const TREE_D = "d".repeat(40);

const VALID_V2 = `
dsl: dzupflow/v1
id: packet-review-v2
version: 1
uses:
  collab: dzup.collab@2
steps:
  - collab.review_loop:
      id: packet
      identity:
        runId: run-001
        planId: production-plan
        planHash: ${HASH_A}
        taskId: PCC-09
        taskDefinitionHash: ${HASH_B}
        repoId: dzupagent
        baseline:
          commit: ${COMMIT_C}
          tree: ${TREE_D}
      implementer:
        provider: codex
        persona: plan-task-implementer
        instructions: Implement only the assigned immutable packet.
        capabilities:
          - worktree.write
        output: packet_implementer_output
      reviewer:
        provider: claude
        persona: plan-task-reviewer
        instructions: Review only the observed packet evidence.
        capabilities:
          - diff.read
          - validation.results
          - evidence.get
        output: packet_reviewer_output
      schemas:
        implementer: controller-implementer-output/v1
        reviewer: controller-reviewer-output/v1
      evidence:
        diff: "{{ state.observed_diff }}"
        validation: "{{ state.validation_results }}"
      validationRef: packet_validation
      reconcile:
        maxRevise: 2
      terminals:
        accepted: review_accepted
        blockedExternal: blocked_external
        rejectedScope: rejected_scope
        rejectedCorrectness: rejected_correctness
        invalidReviewerVerdict: failed_invalid_reviewer_verdict
`;

function validInput(): Record<string, unknown> {
  return {
    id: "packet",
    identity: {
      runId: "run-001",
      planId: "production-plan",
      planHash: HASH_A,
      taskId: "PCC-09",
      taskDefinitionHash: HASH_B,
      repoId: "dzupagent",
      baseline: { commit: COMMIT_C, tree: TREE_D },
    },
    implementer: {
      provider: "codex",
      persona: "plan-task-implementer",
      instructions: "Implement only the assigned immutable packet.",
      capabilities: ["worktree.write"],
      output: "packet_implementer_output",
    },
    reviewer: {
      provider: "claude",
      persona: "plan-task-reviewer",
      instructions: "Review only the observed packet evidence.",
      capabilities: ["diff.read", "validation.results", "evidence.get"],
      output: "packet_reviewer_output",
    },
    schemas: {
      implementer: "controller-implementer-output/v1",
      reviewer: "controller-reviewer-output/v1",
    },
    evidence: {
      diff: "{{ state.observed_diff }}",
      validation: "{{ state.validation_results }}",
    },
    validationRef: "packet_validation",
    reconcile: { maxRevise: 2 },
    terminals: {
      accepted: "review_accepted",
      blockedExternal: "blocked_external",
      rejectedScope: "rejected_scope",
      rejectedCorrectness: "rejected_correctness",
      invalidReviewerVerdict: "failed_invalid_reviewer_verdict",
    },
  };
}

function flattenNodes(node: FlowNode): FlowNode[] {
  const nodes = [node];
  const value = node as unknown as Record<string, unknown>;
  for (const field of ["nodes", "body", "then", "else", "onApprove", "onReject"]) {
    const children = value[field];
    if (Array.isArray(children)) {
      nodes.push(...children.flatMap((child) => flattenNodes(child as FlowNode)));
    }
  }
  if (Array.isArray(value.branches)) {
    for (const branch of value.branches as FlowNode[][]) {
      nodes.push(...branch.flatMap(flattenNodes));
    }
  }
  return nodes;
}

describe("collab.review_loop@2", () => {
  it("is registered additively beside v1 and exported in the primitive catalog", () => {
    const versions = BUILT_IN_PRIMITIVES.filter(
      (definition) => definition.kind === "collab.review_loop",
    ).map((definition) => definition.version).sort();
    expect(versions).toEqual(["1", "2"]);

    const catalogVersions = exportPrimitiveCatalog(BUILT_IN_PRIMITIVES)
      .primitives.filter((entry) => entry.kind === "collab.review_loop")
      .map((entry) => entry.version)
      .sort();
    expect(catalogVersions).toEqual(["1", "2"]);
    expect(
      BUILT_IN_PRIMITIVES.find(
        (definition) =>
          definition.kind === "collab.review_loop" && definition.version === "2",
      )?.schema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining([
        "identity",
        "implementer",
        "reviewer",
        "schemas",
        "evidence",
        "validationRef",
        "reconcile",
        "terminals",
      ]),
      properties: {
        schemas: {
          properties: {
            reviewer: {
              type: "string",
              minLength: 1,
              pattern: "\\S",
            },
          },
        },
        terminals: {
          required: expect.not.arrayContaining(["awaitingApproval"]),
        },
      },
    });
  });

  it("passes parse, document validation, output uniqueness, and primitive-shape gates", () => {
    const parsed = parseDslToDocument(VALID_V2);
    expect(parsed, JSON.stringify(parsed.diagnostics, null, 2)).toMatchObject({
      ok: true,
    });
    if (!parsed.ok) return;

    expect(validateDocument(parsed.document)).toEqual({
      valid: true,
      diagnostics: [],
    });
    expect(checkOutputKeyUniqueness(parsed.document.root)).toEqual([]);

    const nodes = flattenNodes(parsed.document.root);
    const expanded = nodes.slice(1);
    const existingTypes = new Set([
      "adapter.run",
      "evidence.write",
      "validate",
      "validate.schema",
      "branch",
      "return_to",
      "complete",
    ]);
    expect(expanded.every((node) => existingTypes.has(node.type))).toBe(true);
    expect(
      expanded.every(
        (node) =>
          node.meta?.collabExpansion === "packet" &&
          node.meta?.primitive === "collab.review_loop@2",
      ),
    ).toBe(true);

    const outputKeys = expanded.flatMap((node) => {
      if (
        node.type === "adapter.run" ||
        node.type === "evidence.write" ||
        node.type === "validate.schema"
      ) {
        return [node.output];
      }
      return [];
    });
    expect(new Set(outputKeys).size).toBe(outputKeys.length);
  });

  it("keeps every generated state key inside the runtime-resolvable expression subset", () => {
    const parsed = parseDslToDocument(VALID_V2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const nodes = flattenNodes(parsed.document.root);
    const outputNodes = nodes.filter((node) =>
      node.type === "adapter.run" ||
      node.type === "evidence.write" ||
      node.type === "validate.schema"
    );
    const outputKeys = outputNodes.map((node) => node.output);
    expect(outputKeys).toEqual([
      "packet_implementer_output",
      "packet_candidate_evidence",
      "packet_reviewer_output",
      "packet_reviewer_schema_validation",
    ]);
    expect(outputKeys.every((key) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key))).toBe(true);

    const implementerOutput = { result: "candidate_submitted" };
    const candidateEvidence = { digest: "candidate-digest" };
    const reviewerOutput = { verdict: "accept" };
    const state = {
      packet_implementer_output: implementerOutput,
      packet_candidate_evidence: candidateEvidence,
      packet_reviewer_output: reviewerOutput,
      packet_reviewer_schema_validation: { valid: true },
    };

    const evidenceWrite = nodes.find((node) => node.type === "evidence.write");
    expect(evidenceWrite?.source).toBe("{{ state.packet_implementer_output }}");
    expect(resolveFlowTemplateExpression(evidenceWrite?.source ?? "", state)).toBe(
      implementerOutput,
    );

    const reviewer = nodes.filter((node) => node.type === "adapter.run")[1];
    const reviewerInput = reviewer?.input as Record<string, unknown> | undefined;
    const reviewerEvidence = reviewerInput?.evidence as
      | Record<string, unknown>
      | undefined;
    const reviewerCandidate = reviewerEvidence?.candidate;
    expect(reviewerCandidate).toBe("{{ state.packet_candidate_evidence }}");
    expect(resolveFlowTemplateExpression(String(reviewerCandidate), state)).toBe(
      candidateEvidence,
    );

    const schemaValidation = nodes.find((node) => node.type === "validate.schema");
    expect(schemaValidation?.source).toBe("{{ state.packet_reviewer_output }}");
    expect(resolveFlowTemplateExpression(schemaValidation?.source ?? "", state)).toBe(
      reviewerOutput,
    );

    const conditions = nodes
      .filter((node) => node.type === "branch" || node.type === "return_to")
      .map((node) => node.condition);
    expect(conditions.map((condition) =>
      resolveFlowConditionExpression(condition, state)
    )).toEqual([true, false, false, false, false, false]);
  });

  it("binds explicit actors, schemas, evidence, validation, and bounded revision", () => {
    const parsed = parseDslToDocument(VALID_V2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const nodes = flattenNodes(parsed.document.root);
    const adapters = nodes.filter((node) => node.type === "adapter.run");
    expect(adapters).toHaveLength(2);
    expect(adapters[0]).toMatchObject({
      persona: "plan-task-implementer",
      instructions: "Implement only the assigned immutable packet.",
      outputSchema: "controller-implementer-output/v1",
      input: {
        identity: {
          runId: "run-001",
          planHash: HASH_A,
          taskId: "PCC-09",
          taskDefinitionHash: HASH_B,
          baseline: { commit: COMMIT_C, tree: TREE_D },
        },
      },
    });
    expect(adapters[1]).toMatchObject({
      persona: "plan-task-reviewer",
      instructions: "Review only the observed packet evidence.",
      outputSchema: "controller-reviewer-output/v1",
      policy: {
        readOnly: true,
        capabilities: ["diff.read", "validation.results", "evidence.get"],
      },
      input: {
        evidence: {
          candidate: "{{ state.packet_candidate_evidence }}",
          diff: "{{ state.observed_diff }}",
          validation: "{{ state.validation_results }}",
        },
      },
    });
    expect(nodes.find((node) => node.type === "validate")).toMatchObject({
      ref: "packet_validation",
    });
    expect(nodes.find((node) => node.type === "validate.schema")).toMatchObject({
      schema: "controller-reviewer-output/v1",
    });
    expect(nodes.find((node) => node.type === "return_to")).toMatchObject({
      targetId: "packet__implement",
      condition: "state.packet_reviewer_output.verdict === 'revise'",
      maxIterations: 2,
    });
  });

  it("branches only on the declared reviewer verdict and keeps terminals distinct", () => {
    const parsed = parseDslToDocument(VALID_V2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const nodes = flattenNodes(parsed.document.root);
    const expandedDocument = JSON.stringify(parsed.document);
    expect(expandedDocument).not.toContain("state.agree");
    expect(expandedDocument).not.toContain('"nextTask"');
    expect(expandedDocument).not.toContain("awaiting_approval");
    const conditions = nodes
      .filter((node) => node.type === "branch")
      .map((node) => node.condition);
    expect(conditions).toEqual([
      "state.packet_reviewer_output.verdict === 'accept'",
      "state.packet_reviewer_output.verdict === 'revise'",
      "state.packet_reviewer_output.verdict === 'blocked_external'",
      "state.packet_reviewer_output.verdict === 'reject_scope'",
      "state.packet_reviewer_output.verdict === 'reject_correctness'",
    ]);
    expect(conditions.every((condition) =>
      condition.includes("state.packet_reviewer_output.verdict"),
    )).toBe(true);

    const results = nodes
      .filter((node) => node.type === "complete")
      .map((node) => node.result);
    expect(results).toEqual(expect.arrayContaining([
      "review_accepted",
      "blocked_external",
      "rejected_scope",
      "rejected_correctness",
      "failed_invalid_reviewer_verdict",
    ]));
    expect(new Set(results).size).toBe(results.length);
  });

  it.each([
    [
      "dotted macro id that would create ambiguous state paths",
      () => ({ ...validInput(), id: "packet.review" }),
      /input\.id is invalid/,
    ],
    [
      "malformed identity",
      () => ({
        ...validInput(),
        identity: { ...(validInput().identity as object), planHash: "not-a-hash" },
      }),
      /identity\.planHash is invalid/,
    ],
    [
      "missing schemas",
      () => {
        const { schemas: _schemas, ...input } = validInput();
        return input;
      },
      /input\.schemas is required/,
    ],
    [
      "mutable reviewer capability",
      () => ({
        ...validInput(),
        reviewer: {
          ...(validInput().reviewer as object),
          capabilities: ["diff.read", "worktree.write"],
        },
      }),
      /reviewer\.capabilities contains an invalid capability/,
    ],
    [
      "invalid revision bound",
      () => ({ ...validInput(), reconcile: { maxRevise: 3 } }),
      /maxRevise must be an integer between 1 and 2/,
    ],
    [
      "former permissive inline reviewer schema bypass",
      () => ({
        ...validInput(),
        schemas: {
          implementer: "controller-implementer-output/v1",
          reviewer: { type: "object" },
        },
      }),
      /must be a non-empty declarative schema reference; inline reviewer schemas are forbidden/,
    ],
    [
      "composed inline reviewer schema",
      () => ({
        ...validInput(),
        schemas: {
          implementer: "controller-implementer-output/v1",
          reviewer: {
            allOf: [
              { type: "object", properties: { verdict: { type: "string" } } },
              { type: "object", properties: { nextTask: { type: "string" } } },
            ],
          },
        },
      }),
      /must be a non-empty declarative schema reference; inline reviewer schemas are forbidden/,
    ],
    [
      "blank reviewer schema reference",
      () => ({
        ...validInput(),
        schemas: {
          implementer: "controller-implementer-output/v1",
          reviewer: "   ",
        },
      }),
      /must be a non-empty declarative schema reference/,
    ],
    [
      "reviewer-controlled approval terminal",
      () => ({
        ...validInput(),
        terminals: {
          ...(validInput().terminals as object),
          awaitingApproval: "awaiting_approval",
        },
      }),
      /terminals contains unsupported field awaitingApproval/,
    ],
  ])("rejects %s during expansion", (_name, input, expected) => {
    expect(() => expandCollabReviewLoopV2(input())).toThrow(expected);
  });
});
