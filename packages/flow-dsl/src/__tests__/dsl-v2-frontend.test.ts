import { checkOutputKeyUniqueness } from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import {
  lowerDslV2Document,
  parseDslToDocument,
} from "../index.js";

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
        code: "UNSUPPORTED_FIELD",
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
