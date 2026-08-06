/**
 * F-R1 spdd.* codec closure. All 13 spdd kinds were format-only until
 * `normalize-nodes-spdd.ts` landed: the formatter and the flow-ast
 * parser/validator carried every field, but flow-dsl's normalizer had no arm
 * for any spdd kind, so a re-parse died with UNKNOWN_NODE_TYPE and the whole
 * document was reported lost.
 *
 * The DSL-06 matrix (`field-reachability-matrix.test.ts`) proves the MINIMAL
 * fixture of each kind round-trips, but its fixtures deliberately omit every
 * optional field — so optional-field loss is invisible there. This spec covers
 * exactly that gap: each spdd optional is authored explicitly and asserted to
 * survive, and each required field is asserted to fail closed when absent.
 */
import { describe, expect, it } from "vitest";
import type { FlowDocumentV1, FlowNode } from "@dzupagent/flow-ast";

import { formatDocumentToDslChecked } from "../src/format-dsl.js";
import { normalizeDslDocument } from "../src/normalize.js";

function docWith(nodes: FlowNode[]): FlowDocumentV1 {
  return {
    dsl: "dzupflow/v1",
    id: "spdd-fixture",
    version: 1,
    root: { type: "sequence", id: "root", nodes },
  } as FlowDocumentV1;
}

function expectLossless(document: FlowDocumentV1): string {
  const result = formatDocumentToDslChecked(document);
  if (!result.ok) {
    throw new Error(
      `spdd codec lost authored fields: ${result.lossPaths.join(
        ", "
      )}\n--- dsl ---\n${result.dsl}`
    );
  }
  return result.dsl;
}

describe("spdd.* optional-field round-trips", () => {
  it("round-trips spdd.build_source_pack.featureId", () => {
    const dsl = expectLossless(
      docWith([
        {
          type: "spdd.build_source_pack",
          id: "n0",
          spddRunId: "run-1",
          sourceRefsKey: "refs",
          featureId: "feat-42",
          outputKey: "pack",
        } as FlowNode,
      ])
    );
    expect(dsl).toContain("featureId: feat-42");
  });

  it("round-trips spdd.run_analysis.sourceArtifactIds", () => {
    const dsl = expectLossless(
      docWith([
        {
          type: "spdd.run_analysis",
          id: "n0",
          spddRunId: "run-1",
          planArtifactId: "plan-art-1",
          sourceArtifactIds: ["src-a", "src-b"],
          outputKey: "analysis",
        } as FlowNode,
      ])
    );
    expect(dsl).toContain("sourceArtifactIds: [src-a, src-b]");
  });

  it("round-trips spdd.generate_canvas.title and .objective", () => {
    const dsl = expectLossless(
      docWith([
        {
          type: "spdd.generate_canvas",
          id: "n0",
          spddRunId: "run-1",
          promptAssetVersionId: "pav-1",
          title: "Canvas title",
          objective: "Ship the codec",
          outputKey: "canvas",
        } as FlowNode,
      ])
    );
    expect(dsl).toContain("Canvas title");
    expect(dsl).toContain("Ship the codec");
  });

  it("round-trips spdd.run_validation.reviewerId", () => {
    const dsl = expectLossless(
      docWith([
        {
          type: "spdd.run_validation",
          id: "n0",
          spddRunId: "run-1",
          planRunId: "plan-1",
          executionRunId: "exec-1",
          reviewerId: "reviewer-7",
          outputKey: "validation",
        } as FlowNode,
      ])
    );
    expect(dsl).toContain("reviewerId: reviewer-7");
  });

  it("round-trips spdd.collect_proof.taskId", () => {
    const dsl = expectLossless(
      docWith([
        {
          type: "spdd.collect_proof",
          id: "n0",
          spddRunId: "run-1",
          planRunId: "plan-1",
          taskId: "task-9",
          outputKey: "proof",
        } as FlowNode,
      ])
    );
    expect(dsl).toContain("taskId: task-9");
  });

  it("round-trips spdd.agent_swarm sub-tasks including personaRef", () => {
    const dsl = expectLossless(
      docWith([
        {
          type: "spdd.agent_swarm",
          id: "n0",
          spddRunId: "run-1",
          subTasks: [
            { role: "implementer", personaRef: "persona-a", input: { a: 1 } },
            { role: "reviewer", input: {} },
          ],
          outputKey: "swarm",
        } as FlowNode,
      ])
    );
    expect(dsl).toContain("persona-a");
    expect(dsl).toContain("implementer");
  });
});

describe("spdd.* normalizer fails closed", () => {
  /** Normalizes raw authored YAML-shaped input and returns its diagnostics. */
  function diagnose(node: Record<string, unknown>): string[] {
    const { diagnostics } = normalizeDslDocument({
      dsl: "dzupflow/v1",
      id: "spdd-fixture",
      version: 1,
      steps: [{ [String(node["type"])]: node }],
    });
    return diagnostics.map((d) => `${d.code} ${d.path}`);
  }

  it("reports the missing required outputKey rather than defaulting it", () => {
    const codes = diagnose({
      type: "spdd.arm_dispatch",
      id: "n0",
      spddRunId: "run-1",
      planRunId: "plan-1",
    });
    expect(codes.some((c) => c.startsWith("MISSING_REQUIRED_FIELD"))).toBe(
      true
    );
  });

  it("reports an unsupported field instead of silently dropping it", () => {
    const codes = diagnose({
      type: "spdd.arm_dispatch",
      id: "n0",
      spddRunId: "run-1",
      planRunId: "plan-1",
      outputKey: "out",
      bogusField: "x",
    });
    expect(codes.some((c) => c.startsWith("UNSUPPORTED_FIELD"))).toBe(true);
  });

  it("rejects a swarm sub-task missing its role and does not admit it", () => {
    const raw = {
      dsl: "dzupflow/v1",
      id: "spdd-fixture",
      version: 1,
      steps: [
        {
          "spdd.agent_swarm": {
            id: "n0",
            spddRunId: "run-1",
            outputKey: "out",
            subTasks: [{ input: {} }],
          },
        },
      ],
    };
    const { diagnostics, partialDocument } = normalizeDslDocument(raw);
    // The specific code matters: a generic diagnostic at the same path would
    // let a "role is optional" regression through.
    expect(
      diagnostics.some(
        (d) =>
          d.code === "MISSING_REQUIRED_FIELD" &&
          d.path.includes("subTasks[0].role")
      ),
      diagnostics.map((d) => `${d.code} ${d.path}`).join(" | ")
    ).toBe(true);
    // ...and the malformed sub-task must be DROPPED, not admitted with a
    // synthesized empty role.
    const node = partialDocument?.root.nodes[0] as
      | { subTasks?: unknown[] }
      | undefined;
    expect(node?.subTasks ?? []).toEqual([]);
  });

  it("admits a well-formed swarm sub-task, so the rejection above is not vacuous", () => {
    const { diagnostics } = normalizeDslDocument({
      dsl: "dzupflow/v1",
      id: "spdd-fixture",
      version: 1,
      steps: [
        {
          "spdd.agent_swarm": {
            id: "n0",
            spddRunId: "run-1",
            outputKey: "out",
            subTasks: [{ role: "implementer", input: {} }],
          },
        },
      ],
    });
    expect(diagnostics).toEqual([]);
  });
});
