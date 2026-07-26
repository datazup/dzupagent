import { checkOutputKeyUniqueness } from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import {
  formatDocumentToDsl,
  lowerDslV2Document,
  parseDslToDocument,
} from "../index.js";
import {
  createDslSourceMap,
  resolveDslSourceSpan,
} from "../dsl-source-map.js";

const V1_EQUIVALENT = `
dsl: dzupflow/v1
id: bounded-v2
version: 1
uses:
  adapter: dzup.adapter@1
steps:
  - set:
      id: seed
      assign:
        ready: true
  - if:
      id: choose
      condition: "{{ state.ready }}"
      then:
        - adapter.run:
            id: draft
            provider: codex
            instructions: Draft the bounded result.
            output: draft
      else:
        - complete:
            id: skipped
            result: skipped
  - complete:
      id: done
      result: accepted
`;

const V2_EQUIVALENT = `
dsl: dzupflow/v2
id: bounded-v2
version: 2.0.0
steps:
  - id: seed
    use: core.set@1
    with:
      assign:
        ready: true
  - id: choose
    use: core.branch@1
    when: "{{ state.ready }}"
    with:
      then:
        - id: draft
          use: adapter.run@1
          with:
            provider: codex
            instructions: Draft the bounded result.
          save:
            result: state.draft
      else:
        - id: skipped
          use: core.complete@1
          with:
            result: skipped
  - id: done
    use: core.complete@1
    with:
      result: accepted
`;

const V1_COMPOSITE = `
dsl: dzupflow/v1
id: review-v2-frontend
version: 1
uses:
  collab: dzup.collab@1
steps:
  - collab.review_loop:
      id: review
      task:
        kind: implementation
      proposer:
        executionProviderId: codex
      critic:
        executionProviderId: claude
`;

const V2_COMPOSITE = `
dsl: dzupflow/v2
id: review-v2-frontend
version: 2.0.0
steps:
  - id: review
    use: collab.review_loop@1
    with:
      task:
        kind: implementation
      proposer:
        executionProviderId: codex
      critic:
        executionProviderId: claude
`;

const V2_GUARDED_COMPOSITE = `
dsl: dzupflow/v2
id: guarded-review-v2-frontend
version: 2.0.0
inputs:
  ready: boolean
steps:
  - id: review
    use: collab.review_loop@1
    when:
      ref: inputs.ready
    with:
      task:
        kind: implementation
      proposer:
        executionProviderId: codex
      critic:
        executionProviderId: claude
`;

const V2_TYPED_GUARDS = `
dsl: dzupflow/v2
id: typed-v2-guards
version: 2.0.0
inputs:
  ready: boolean
  score: number
steps:
  - id: seed
    use: core.set@1
    when:
      ref: inputs.ready
    with:
      assign:
        seeded: true
  - id: draft
    use: adapter.run@1
    when:
      gte:
        - ref: inputs.score
        - 3
    with:
      provider: codex
      instructions: Draft the typed result.
    save:
      result: state.draft
  - id: done
    use: core.complete@1
    when:
      not:
        ref: inputs.ready
    with:
      result: accepted
`;

describe("bounded dzupflow/v2 frontend", () => {
  it("lowers uniform set, branch, invoke, and complete steps to equal canonical v1", () => {
    const v1 = parseDslToDocument(V1_EQUIVALENT);
    const v2 = parseDslToDocument(V2_EQUIVALENT);

    expect(v1, JSON.stringify(v1.diagnostics, null, 2)).toMatchObject({
      ok: true,
    });
    expect(v2, JSON.stringify(v2.diagnostics, null, 2)).toMatchObject({
      ok: true,
    });
    if (!v1.ok || !v2.ok) return;

    expect(v2.document).toEqual(v1.document);
    expect(checkOutputKeyUniqueness(v2.document.root)).toEqual([]);
    expect(v2.frontend).toMatchObject({
      schema: "dzupagent.dslV2Frontend/v1",
      authoredDsl: "dzupflow/v2",
      authoredVersion: "2.0.0",
      canonicalDsl: "dzupflow/v1",
      canonicalVersion: 1,
      primitiveBindings: [
        {
          ref: "primitive://adapter.run@1",
          semanticHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      ],
    });
    expect(v2.frontend?.stepLineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authoredPath: "root.steps[1].with.then[0]",
          loweredPath: "steps[1].if.then[0]",
          use: "adapter.run@1",
          primitiveRef: "primitive://adapter.run@1",
        }),
      ]),
    );
    expect(Object.isFrozen(v2.frontend)).toBe(true);
    expect(Object.isFrozen(v2.frontend?.stepLineage)).toBe(true);
  });

  it("preserves exact composite expansion and semantic lineage across v1 and v2", () => {
    const v1 = parseDslToDocument(V1_COMPOSITE, {
      requirePrimitiveLineage: true,
    });
    const v2 = parseDslToDocument(V2_COMPOSITE);

    expect(v1, JSON.stringify(v1.diagnostics, null, 2)).toMatchObject({
      ok: true,
    });
    expect(v2, JSON.stringify(v2.diagnostics, null, 2)).toMatchObject({
      ok: true,
    });
    if (!v1.ok || !v2.ok) return;

    expect(v2.document).toEqual(v1.document);
    expect(v2.document.meta?.primitiveExpansions).toEqual([
      expect.objectContaining({
        ref: "primitive://collab.review_loop@1",
        semanticHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        invocationPath: "steps[0]",
      }),
    ]);
    expect(v2.frontend?.primitiveBindings).toEqual([
      {
        ref: "primitive://collab.review_loop@1",
        semanticHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    ]);
    expect(
      JSON.stringify(v2.document),
    ).not.toContain("__dzupV2SourceLineage");

    const guarded = parseDslToDocument(V2_GUARDED_COMPOSITE);
    expect(
      guarded,
      JSON.stringify(guarded.diagnostics, null, 2),
    ).toMatchObject({ ok: true });
    if (!guarded.ok) return;
    expect(guarded.document.root.nodes[0]).toMatchObject({
      type: "branch",
      id: "review__when_guard",
      condition: "false",
      then: [
        { type: "adapter.run", id: "review__propose" },
        { type: "adapter.run", id: "review__critique" },
        { type: "branch", id: "review__reconcile" },
      ],
    });
    expect(guarded.document.meta?.primitiveExpansions).toEqual([
      expect.objectContaining({
        ref: "primitive://collab.review_loop@1",
        semanticHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        invocationPath: "steps[0].then[0]",
      }),
    ]);
    expect(guarded.frontend?.stepLineage).toContainEqual(
      expect.objectContaining({
        authoredPath: "root.steps[0]",
        loweredPath: "steps[0].if.then[0]",
        guardId: "review__when_guard",
        primitiveRef: "primitive://collab.review_loop@1",
        primitiveSemanticHash:
          expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    );
    expect(
      guarded.sourceMap?.entries[
        "root.nodes[0].then[0].instructions"
      ],
    ).toMatchObject({
      authoredPath: "root.steps[0].use",
      derived: true,
    });
  });

  it("retains typed v2 guards in fail-closed canonical branches", () => {
    const parsed = parseDslToDocument(V2_TYPED_GUARDS);
    expect(parsed, JSON.stringify(parsed.diagnostics, null, 2)).toMatchObject({
      ok: true,
    });
    if (!parsed.ok) return;

    expect(parsed.document.root).toMatchObject({
      type: "sequence",
      nodes: [
        {
          type: "branch",
          id: "seed__when_guard",
          condition: "false",
          typedCondition: {
            schema: "dzupagent.flowTypedCondition/v1",
            expression: { op: "ref", path: "inputs.ready" },
          },
          then: [{ type: "set", id: "seed" }],
        },
        {
          type: "branch",
          id: "draft__when_guard",
          condition: "false",
          typedCondition: {
            schema: "dzupagent.flowTypedCondition/v1",
            expression: {
              op: "gte",
              left: { op: "ref", path: "inputs.score" },
              right: { op: "literal", value: 3 },
            },
          },
          then: [{ type: "adapter.run", id: "draft", output: "draft" }],
        },
        {
          type: "branch",
          id: "done__when_guard",
          condition: "false",
          typedCondition: {
            schema: "dzupagent.flowTypedCondition/v1",
            expression: {
              op: "not",
              arg: { op: "ref", path: "inputs.ready" },
            },
          },
          then: [{ type: "complete", id: "done" }],
        },
      ],
    });
    expect(checkOutputKeyUniqueness(parsed.document.root)).toEqual([]);
    expect(JSON.stringify(parsed.document)).not.toContain(
      "__dzupV2SourceLineage",
    );
    expect(parsed.frontend?.stepLineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authoredPath: "root.steps[1]",
          loweredPath: "steps[1].if.then[0]",
          guardId: "draft__when_guard",
          guardLoweredPath: "steps[1]",
          primitiveRef: "primitive://adapter.run@1",
          primitiveSemanticHash:
            expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      ]),
    );

    const sourceMap = parsed.sourceMap;
    expect(sourceMap).toBeDefined();
    if (sourceMap === undefined) return;
    const guard = sourceMap.entries["root.nodes[1].typedCondition"];
    const shadow = sourceMap.entries["root.nodes[1].condition"];
    const child = sourceMap.entries["root.nodes[1].then[0].instructions"];
    expect(guard).toMatchObject({
      authoredPath: "root.steps[1].when",
    });
    expect(guard?.derived).not.toBe(true);
    expect(shadow).toMatchObject({
      authoredPath: "root.steps[1].when",
      derived: true,
    });
    expect(child).toMatchObject({
      authoredPath: "root.steps[1].with.instructions",
    });
    expect(
      V2_TYPED_GUARDS.slice(guard?.valueSpan?.start, guard?.valueSpan?.end),
    ).toContain("gte:");

    const reparsed = parseDslToDocument(formatDocumentToDsl(parsed.document));
    expect(
      reparsed,
      JSON.stringify(reparsed.diagnostics, null, 2),
    ).toMatchObject({ ok: true });
    if (reparsed.ok) {
      expect(reparsed.document.root).toEqual(parsed.document.root);
    }
  });

  it("accepts typed explicit branches and rejects unsafe typed conditions", () => {
    const branch = lowerDslV2Document({
      dsl: "dzupflow/v2",
      id: "typed-branch",
      version: "2.0.0",
      inputs: { ready: "boolean" },
      steps: [{
        id: "choose",
        use: "core.branch@1",
        when: { ref: "inputs.ready" },
        with: {
          then: [{
            id: "done",
            use: "core.complete@1",
            with: { result: "done" },
          }],
        },
      }],
    });
    expect(branch, JSON.stringify(branch.diagnostics, null, 2)).toMatchObject({
      ok: true,
    });

    for (const { when, code } of [
      { when: { random: true }, code: "V2_NONDETERMINISTIC_CONDITION" },
      {
        when: { exprJs: "inputs.ready" },
        code: "V2_NONDETERMINISTIC_CONDITION",
      },
      { when: { bogus: true }, code: "V2_INVALID_TYPED_CONDITION" },
      { when: { eq: [true] }, code: "V2_INVALID_TYPED_CONDITION" },
    ]) {
      const result = lowerDslV2Document({
        dsl: "dzupflow/v2",
        id: "unsafe-condition",
        version: "2.0.0",
        inputs: {
          ready: "boolean",
          score: "number",
          items: "array",
        },
        steps: [{
          id: "guarded",
          use: "core.complete@1",
          when,
          with: { result: "done" },
        }],
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code,
          }),
        ]),
      );
    }

    const collision = lowerDslV2Document({
      dsl: "dzupflow/v2",
      id: "guard-id-collision",
      version: "2.0.0",
      steps: [
        {
          id: "guarded",
          use: "core.complete@1",
          when: true,
          with: { result: "done" },
        },
        {
          id: "guarded__when_guard",
          use: "core.complete@1",
          with: { result: "conflict" },
        },
      ],
    });
    expect(collision.ok).toBe(false);
    expect(collision.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "V2_GUARD_ID_CONFLICT",
        path: "root.steps[0].id",
      }),
    );
  });

  it("composes exact authored fields and derived expansion breadcrumbs into canonical source paths", () => {
    const parsed = parseDslToDocument(V2_EQUIVALENT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const sourceMap =
      parsed.sourceMap ?? createDslSourceMap(V2_EQUIVALENT, parsed.document);
    expect(sourceMap).toBeDefined();
    if (sourceMap === undefined) return;

    const when = resolveDslSourceSpan(
      sourceMap,
      "root.nodes[1].condition",
    );
    const instructions = resolveDslSourceSpan(
      sourceMap,
      "root.nodes[1].then[0].instructions",
    );
    const savedOutput = resolveDslSourceSpan(
      sourceMap,
      "root.nodes[1].then[0].output",
    );
    expect(V2_EQUIVALENT.slice(when?.start, when?.end)).toBe(
      '"{{ state.ready }}"',
    );
    expect(
      V2_EQUIVALENT.slice(instructions?.start, instructions?.end),
    ).toBe("Draft the bounded result.");
    expect(V2_EQUIVALENT.slice(savedOutput?.start, savedOutput?.end)).toBe(
      "state.draft",
    );
    expect(
      sourceMap.entries["root.nodes[1].then[0].output"],
    ).toMatchObject({
      authoredPath: "root.steps[1].with.then[0].save.result",
      derived: true,
    });
    expect(
      resolveDslSourceSpan(
        sourceMap,
        "root.nodes[1].then[0].output",
        { start: 0, end: 5 },
      ),
    ).toBeUndefined();

    const composite = parseDslToDocument(V2_COMPOSITE);
    expect(composite.ok).toBe(true);
    if (!composite.ok || composite.sourceMap === undefined) return;
    expect(
      composite.sourceMap.entries["root.nodes[0].instructions"],
    ).toMatchObject({
      authoredPath: "root.steps[0].use",
      derived: true,
    });
    const generated = resolveDslSourceSpan(
      composite.sourceMap,
      "root.nodes[0].instructions",
    );
    expect(V2_COMPOSITE.slice(generated?.start, generated?.end)).toBe(
      "collab.review_loop@1",
    );
  });

  it("attaches an exact authored span to v2 envelope diagnostics", () => {
    const source = `dsl: dzupflow/v2
id: invalid-save
version: 2.0.0
steps:
  - id: invoke
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    save:
      missing: state.value
`;
    const parsed = parseDslToDocument(source);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "V2_UNKNOWN_OUTPUT_PORT",
        path: "root.steps[0].save.missing",
        span: expect.objectContaining({
          lineStart: 11,
          lineEnd: 11,
        }),
      }),
    );
  });

  it("fails closed on unpinned, unknown, unsupported, and unsafe save contracts", () => {
    const cases = [
      {
        raw: {
          dsl: "dzupflow/v2",
          id: "unpinned",
          version: "2.0.0",
          steps: [{ id: "x", use: "adapter.run", with: {} }],
        },
        code: "V2_UNPINNED_USE",
      },
      {
        raw: {
          dsl: "dzupflow/v2",
          id: "unknown",
          version: "2.0.0",
          steps: [{ id: "x", use: "custom.missing@1", with: {} }],
        },
        code: "V2_UNKNOWN_PRIMITIVE",
      },
      {
        raw: {
          dsl: "dzupflow/v2",
          id: "policy",
          version: "2.0.0",
          steps: [
            {
              id: "x",
              use: "core.complete@1",
              with: { result: "done" },
              policy: { timeoutMs: 1 },
            },
          ],
        },
        code: "V2_POLICY_REQUIRES_PRIMITIVE",
      },
      {
        raw: {
          dsl: "dzupflow/v2",
          id: "port",
          version: "2.0.0",
          steps: [
            {
              id: "x",
              use: "adapter.run@1",
              with: {
                provider: "codex",
                instructions: "Draft.",
              },
              save: { missing: "state.value" },
            },
          ],
        },
        code: "V2_UNKNOWN_OUTPUT_PORT",
      },
      {
        raw: {
          dsl: "dzupflow/v2",
          id: "target",
          version: "2.0.0",
          steps: [
            {
              id: "x",
              use: "adapter.run@1",
              with: {
                provider: "codex",
                instructions: "Draft.",
              },
              save: { result: "outputs.value" },
            },
          ],
        },
        code: "V2_INVALID_SAVE_TARGET",
      },
    ];

    for (const fixture of cases) {
      const result = lowerDslV2Document(fixture.raw);
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain(
        fixture.code,
      );
    }
  });

  it("rejects unsupported top-level surfaces and namespace version conflicts", () => {
    const unsupported = lowerDslV2Document({
      dsl: "dzupflow/v2",
      id: "future",
      version: "2.0.0",
      profiles: ["dzup.core@2"],
      steps: [],
    });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNSUPPORTED_FIELD",
          path: "root.profiles",
        }),
      ]),
    );

    const conflict = lowerDslV2Document({
      dsl: "dzupflow/v2",
      id: "conflict",
      version: "2.0.0",
      steps: [
        {
          id: "review-v1",
          use: "collab.review_loop@1",
          with: {},
        },
        {
          id: "review-v2",
          use: "collab.review_loop@2",
          with: {},
        },
      ],
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "V2_NAMESPACE_VERSION_CONFLICT",
        }),
      ]),
    );
  });
});
