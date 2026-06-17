/**
 * P0 — DSL Durability Contract (flow-ast layer).
 *
 * Verifies the additive, backward-compatible durability surface:
 *  - top-level `FlowDocumentV1.durability` (FlowDurabilityPolicy)
 *  - shared `NodeIdempotencyMode` reused across side-effecting nodes
 *  - `EffectClass` + mapping from the coarse `FlowMutationMetadata.policy`
 *  - `FlowResumeMetadata` extended with `safeToReplayFrom`
 *
 * Per the reconciliation decision (2026-06-17), these EXTEND the landed
 * `adapter.*` conventions — they do not introduce a parallel structure.
 *
 * See workspace-docs/repos/dzupagent/docs/architecture/plans/P0-dsl-durability-contract.md
 */
import { describe, it, expect } from "vitest";
import { flowDocumentSchema } from "../validate.js";
import {
  EFFECT_CLASSES,
  NODE_IDEMPOTENCY_MODES,
  effectClassFromMutationPolicy,
  type EffectClass,
  type FlowDurabilityPolicy,
  type NodeIdempotencyMode,
} from "../index.js";

const validRoot = {
  type: "sequence",
  id: "root",
  nodes: [{ type: "complete", id: "done" }],
};

const baseDocument = {
  dsl: "dzupflow/v1",
  id: "wf-durability-test",
  version: 1,
  root: validRoot,
};

// ── Shared idempotency mode ──────────────────────────────────────────────────

describe("NodeIdempotencyMode", () => {
  it("enumerates the three modes shared with adapter.* nodes", () => {
    expect(NODE_IDEMPOTENCY_MODES).toEqual([
      "idempotent",
      "at-least-once",
      "exactly-once-required",
    ]);
  });

  it("is assignable from the adapter-node string literals", () => {
    const m: NodeIdempotencyMode = "exactly-once-required";
    expect(NODE_IDEMPOTENCY_MODES).toContain(m);
  });
});

// ── EffectClass + mapping ────────────────────────────────────────────────────

describe("EffectClass", () => {
  it("enumerates the nine effect classes (spec §5.5)", () => {
    expect(EFFECT_CLASSES).toEqual([
      "read",
      "compute",
      "llm",
      "file_write",
      "code_change",
      "network_write",
      "db_write",
      "human_decision",
      "queue_publish",
    ]);
  });

  it("maps the coarse FlowMutationMetadata.policy onto an EffectClass", () => {
    expect(effectClassFromMutationPolicy("read-only")).toBe<EffectClass>(
      "read",
    );
    expect(effectClassFromMutationPolicy("idempotent")).toBe<EffectClass>(
      "compute",
    );
    expect(effectClassFromMutationPolicy("mutating")).toBe<EffectClass>(
      "db_write",
    );
    expect(effectClassFromMutationPolicy(undefined)).toBeUndefined();
  });
});

// ── Top-level durability — happy path ────────────────────────────────────────

describe("document.durability — happy path", () => {
  it("parses durability.mode", () => {
    const r = flowDocumentSchema.safeParse({
      ...baseDocument,
      durability: { mode: "durable" } satisfies FlowDurabilityPolicy,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.durability?.mode).toBe("durable");
  });

  it("parses checkpoint.strategy + resume.onProcessRestart", () => {
    const r = flowDocumentSchema.safeParse({
      ...baseDocument,
      durability: {
        mode: "checkpointed",
        checkpoint: { strategy: "after_each_node" },
        resume: {
          onProcessRestart: "resume_from_checkpoint",
          requireResumePoint: true,
        },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.durability?.checkpoint?.strategy).toBe("after_each_node");
      expect(r.data.durability?.resume?.onProcessRestart).toBe(
        "resume_from_checkpoint",
      );
      expect(r.data.durability?.resume?.requireResumePoint).toBe(true);
    }
  });

  it("defaults to absent when not declared (backward compatible)", () => {
    const r = flowDocumentSchema.safeParse(baseDocument);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.durability).toBeUndefined();
  });
});

// ── Top-level durability — rejection ─────────────────────────────────────────

describe("document.durability — rejection", () => {
  it("rejects a non-object durability", () => {
    const r = flowDocumentSchema.safeParse({
      ...baseDocument,
      durability: "durable",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown mode", () => {
    const r = flowDocumentSchema.safeParse({
      ...baseDocument,
      durability: { mode: "sometimes" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown checkpoint.strategy", () => {
    const r = flowDocumentSchema.safeParse({
      ...baseDocument,
      durability: { mode: "durable", checkpoint: { strategy: "whenever" } },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown resume.onProcessRestart", () => {
    const r = flowDocumentSchema.safeParse({
      ...baseDocument,
      durability: { mode: "durable", resume: { onProcessRestart: "pray" } },
    });
    expect(r.success).toBe(false);
  });
});
