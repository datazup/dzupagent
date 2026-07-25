import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  createPrimitiveRegistryV2,
  definePrimitiveV2,
  parseDslToDocument,
  type PrimitiveDefinitionV2,
} from "../index.js";
import {
  DSL_V2_AUTHORING_ID,
  formatDslV2Document,
  importDslV2Source,
  previewDslV1ToV2Migration,
} from "../v2-authoring.js";
import { describe, expect, it } from "vitest";

function multiPortRegistry() {
  const base = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve("adapter.run", "1");
  if (base === undefined) throw new Error("missing adapter.run@1");
  const {
    compatibility: { semanticHash: _semanticHash, ...compatibility },
    ...contract
  } = base;
  const primitive: PrimitiveDefinitionV2 = definePrimitiveV2({
    ...contract,
    outputPorts: {
      result: base.outputPorts.result!,
      receipt: {
        schema: {
          type: "object",
          required: ["digest"],
          properties: { digest: { type: "string" } },
          additionalProperties: false,
        },
        cardinality: "one",
        classification: "internal",
        persistence: "state",
      },
    },
    compatibility: { ...compatibility },
  });
  return createPrimitiveRegistryV2(
    BUILT_IN_PRIMITIVE_REGISTRY_V2.list().map((entry) =>
      entry.ref === primitive.ref ? primitive : entry
    )
  );
}

const FULL_V2 = `# canonical comments are intentionally not retained
dsl: dzupflow/v2
id: authoring-roundtrip
version: 2.0.0
inputs:
  score: number
steps:
  - save:
      result: state.result
      receipt: state.receipt
    catch:
      - action: continue
        match: [ADAPTER_CANCELLED]
    retry:
      maxAttempts: 3
      match: [ADAPTER_FAILED]
      backoff:
        maxMs: 20
        initialMs: 10
        jitter: full
        strategy: exponential
    policy:
      requireApproval: true
      budgetCents: 25
      timeoutMs: 30000
    with:
      instructions: Draft.
      provider: codex
    when:
      all:
        - gte:
            - ref: inputs.score
            - 3
        - exists:
            ref: inputs.score
    use: adapter.run@1
    id: run
`;

function withExactPrimitiveImport(
  source: string,
  registry: ReturnType<typeof multiPortRegistry>
): string {
  const primitive = registry.resolve("adapter.run", "1");
  if (primitive === undefined) throw new Error("missing adapter.run@1");
  return source.replace(
    "inputs:\n",
    `imports:\n  primitives:\n    - ref: ${primitive.ref}\n      semanticHash: ${primitive.compatibility.semanticHash}\ninputs:\n`
  );
}

const V1_EQUIVALENT = `dsl: dzupflow/v1
id: migrate-exact
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
            instructions: Draft.
            output: draft
      else:
        - complete:
            id: skipped
            result: skipped
  - complete:
      id: done
      result: accepted
`;

describe(DSL_V2_AUTHORING_ID, () => {
  it("imports and deterministically formats the complete qualified V2 subset", () => {
    const registry = multiPortRegistry();
    const source = withExactPrimitiveImport(FULL_V2, registry);
    const first = importDslV2Source(source, {
      primitiveRegistryV2: registry,
    });
    const second = importDslV2Source(source, {
      primitiveRegistryV2: registry,
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      authoringId: DSL_V2_AUTHORING_ID,
      comments: "not-preserved",
      authority: {
        sourceFormatting: true,
        reportOnlyMigration: true,
        documentMutation: false,
        runtimeExecution: false,
        providerDispatch: false,
        deployment: false,
        activation: false,
      },
    });
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    expect(first.canonicalSource).not.toContain("canonical comments");
    expect(first.canonicalSource.indexOf("    id: run")).toBeLessThan(
      first.canonicalSource.indexOf("    use: adapter.run@1")
    );
    expect(first.canonicalSource.indexOf("    policy:")).toBeLessThan(
      first.canonicalSource.indexOf("    retry:")
    );
    expect(first.frontend.policyNarrowings).toHaveLength(1);
    expect(first.frontend).toMatchObject({
      primitiveImportMode: "explicit",
      primitiveImports: [
        {
          ref: "primitive://adapter.run@1",
          semanticHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
      ],
    });
    expect(first.frontend.retryPolicies).toHaveLength(1);
    expect(first.frontend.terminalCatches).toHaveLength(1);
    expect(first.frontend.multiPortSaves).toHaveLength(1);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.document)).toBe(true);

    const reparsed = importDslV2Source(first.canonicalSource, {
      primitiveRegistryV2: registry,
    });
    expect(reparsed).toMatchObject({
      ok: true,
      canonicalSource: first.canonicalSource,
      canonicalSourceSha256: first.canonicalSourceSha256,
      semanticSha256: first.semanticSha256,
    });
  });

  it("requires explicit primitive imports to match the exact used closure", () => {
    const registry = multiPortRegistry();
    const primitive = registry.resolve("adapter.run", "1")!;
    const missing = importDslV2Source(
      FULL_V2.replace("inputs:\n", "imports:\n  primitives: []\ninputs:\n"),
      { primitiveRegistryV2: registry }
    );
    expect(missing).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "V2_INVALID_IMPORT" }),
      ]),
    });

    const drifted = importDslV2Source(
      FULL_V2.replace(
        "inputs:\n",
        `imports:\n  primitives:\n    - ref: ${
          primitive.ref
        }\n      semanticHash: sha256:${"0".repeat(64)}\ninputs:\n`
      ),
      { primitiveRegistryV2: registry }
    );
    expect(drifted).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "V2_INVALID_IMPORT",
          path: "root.imports.primitives[0].semanticHash",
        }),
      ]),
    });

    const unusedDefinition = registry.resolve("validate", "1")!;
    const unused = importDslV2Source(
      withExactPrimitiveImport(FULL_V2, registry).replace(
        "inputs:\n",
        `    - ref: ${unusedDefinition.ref}\n      semanticHash: ${unusedDefinition.compatibility.semanticHash}\ninputs:\n`
      ),
      { primitiveRegistryV2: registry }
    );
    expect(unused).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "V2_INVALID_IMPORT" }),
      ]),
    });
  });

  it("formats JSON input with stable key order and no caller mutation", () => {
    const input = {
      steps: [
        {
          with: { result: "done" },
          use: "core.complete@1",
          id: "done",
        },
      ],
      version: "2.0.0",
      id: "json-format",
      dsl: "dzupflow/v2",
    };
    const snapshot = structuredClone(input);
    const result = formatDslV2Document(input);

    expect(input).toEqual(snapshot);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.canonicalSource).toMatch(
      /^dsl: dzupflow\/v2\nid: json-format\nversion: 2\.0\.0\nsteps:/u
    );
  });

  it("binds an explicit primitive import closure to exact registry hashes", () => {
    const primitive = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve(
      "adapter.run",
      "1"
    );
    if (primitive === undefined) throw new Error("missing adapter.run@1");
    const result = formatDslV2Document({
      dsl: "dzupflow/v2",
      id: "explicit-imports",
      version: "2.0.0",
      imports: {
        primitives: [
          {
            ref: primitive.ref,
            semanticHash: primitive.compatibility.semanticHash,
          },
        ],
      },
      steps: [
        {
          id: "draft",
          use: "adapter.run@1",
          with: { provider: "codex", instructions: "Draft." },
          save: { result: "state.draft" },
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      frontend: {
        primitiveImportMode: "explicit",
        primitiveImports: [
          {
            ref: primitive.ref,
            semanticHash: primitive.compatibility.semanticHash,
          },
        ],
      },
    });
    if (!result.ok) return;
    expect(result.canonicalSource.indexOf("imports:")).toBeLessThan(
      result.canonicalSource.indexOf("steps:")
    );
  });

  it("rejects missing, unused, duplicate, and hash-drifted primitive imports", () => {
    const primitive = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve(
      "adapter.run",
      "1"
    );
    if (primitive === undefined) throw new Error("missing adapter.run@1");
    const adapterStep = {
      id: "draft",
      use: "adapter.run@1",
      with: { provider: "codex", instructions: "Draft." },
      save: { result: "state.draft" },
    };
    const base = {
      dsl: "dzupflow/v2",
      id: "invalid-imports",
      version: "2.0.0",
    };
    const exact = {
      ref: primitive.ref,
      semanticHash: primitive.compatibility.semanticHash,
    };
    const cases = [
      { imports: { primitives: [] }, steps: [adapterStep] },
      {
        imports: { primitives: [exact] },
        steps: [{ id: "done", use: "core.complete@1", with: {} }],
      },
      { imports: { primitives: [exact, exact] }, steps: [adapterStep] },
      {
        imports: {
          primitives: [{ ...exact, semanticHash: `sha256:${"0".repeat(64)}` }],
        },
        steps: [adapterStep],
      },
    ];

    for (const fixture of cases) {
      expect(formatDslV2Document({ ...base, ...fixture })).toMatchObject({
        ok: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "V2_INVALID_IMPORT" }),
        ]),
      });
    }
  });

  it("reports unsupported and non-JSON fields instead of dropping them", () => {
    const unsupported = importDslV2Source(`dsl: dzupflow/v2
id: unsupported
version: 2.0.0
future: true
steps:
  - id: done
    use: core.complete@1
    futureStep: true
    with:
      result: done
`);
    expect(unsupported).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "UNSUPPORTED_FIELD",
          path: "root.future",
        }),
        expect.objectContaining({
          code: "UNSUPPORTED_FIELD",
          path: "root.steps[0].futureStep",
        }),
      ]),
    });

    expect(
      formatDslV2Document({
        dsl: "dzupflow/v2",
        id: "non-json",
        version: "2.0.0",
        meta: { created: new Date(0) },
        steps: [],
      })
    ).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "V2_AUTHORING_NON_JSON_VALUE",
          path: "root.meta.created",
        }),
      ],
    });
  });

  it("rejects V1 input at the V2 authoring boundary", () => {
    expect(importDslV2Source(V1_EQUIVALENT)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_DSL_VERSION" }),
      ]),
    });
  });

  it("produces an exact report-only V1-to-V2 candidate", () => {
    const report = previewDslV1ToV2Migration(V1_EQUIVALENT);

    expect(report).toMatchObject({
      schema: "dzupagent.dslV1ToV2MigrationReport/v1",
      classification: "equivalent",
      canonicalEquivalent: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          nodeType: "set",
          classification: "equivalent",
        }),
        expect.objectContaining({
          nodeType: "branch",
          classification: "equivalent",
        }),
        expect.objectContaining({
          nodeType: "adapter.run",
          classification: "equivalent",
        }),
        expect.objectContaining({
          nodeType: "complete",
          classification: "equivalent",
        }),
      ]),
      authority: {
        reportOnlyMigration: true,
        documentMutation: false,
        runtimeExecution: false,
      },
    });
    expect(report.candidateSource).toContain("dsl: dzupflow/v2");
    expect(report.candidateSource).toContain("imports:");
    expect(report.primitiveImports).toEqual([
      {
        ref: "primitive://adapter.run@1",
        semanticHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    ]);
    expect(report.sourceSemanticSha256).toBe(report.candidateSemanticSha256);
    expect(Object.isFrozen(report)).toBe(true);

    const v1 = parseDslToDocument(V1_EQUIVALENT);
    const v2 = parseDslToDocument(report.candidateSource!);
    expect(v1).toMatchObject({ ok: true });
    expect(v2).toMatchObject({ ok: true });
    if (v1.ok && v2.ok) expect(v2.document).toEqual(v1.document);
  });

  it("round-trips deterministic typed conditions through migration", () => {
    const source = `dsl: dzupflow/v1
id: typed-migration
version: 1
inputs:
  score: number
steps:
  - if:
      id: choose
      condition: "false"
      typedCondition:
        schema: dzupagent.flowTypedCondition/v1
        expression:
          op: gte
          left:
            op: ref
            path: inputs.score
          right:
            op: literal
            value: 3
      then:
        - complete:
            id: done
            result: accepted
`;
    const report = previewDslV1ToV2Migration(source);
    expect(report).toMatchObject({
      classification: "equivalent",
      canonicalEquivalent: true,
    });
    expect(report.candidateSource).toContain("gte:");
  });

  it("classifies lossy and unsupported V1 nodes without emitting candidates", () => {
    const lossy = previewDslV1ToV2Migration(`dsl: dzupflow/v1
id: lossy
version: 1
steps:
  - complete:
      id: done
      description: Retain me.
      result: accepted
`);
    expect(lossy).toMatchObject({
      classification: "lossy",
      canonicalEquivalent: false,
    });
    expect(lossy).not.toHaveProperty("candidateSource");

    const unsupported = previewDslV1ToV2Migration(`dsl: dzupflow/v1
id: unsupported
version: 1
steps:
  - approval:
      id: gate
      question: Continue?
      onApprove:
        - complete:
            id: done
            result: accepted
`);
    expect(unsupported).toMatchObject({
      classification: "unsupported",
      canonicalEquivalent: false,
      items: expect.arrayContaining([
        expect.objectContaining({
          nodeType: "approval",
          classification: "unsupported",
        }),
      ]),
    });
    expect(unsupported).not.toHaveProperty("candidateSource");
  });

  it("classifies malformed and non-V1 sources as invalid", () => {
    expect(previewDslV1ToV2Migration("dsl:\tbad")).toMatchObject({
      classification: "invalid",
      canonicalEquivalent: false,
    });
    expect(
      previewDslV1ToV2Migration(`dsl: dzupflow/v2
id: already-v2
version: 2.0.0
steps: []
`)
    ).toMatchObject({
      classification: "invalid",
      diagnostics: [
        expect.objectContaining({ code: "V1_TO_V2_SOURCE_REQUIRED" }),
      ],
    });
  });
});
