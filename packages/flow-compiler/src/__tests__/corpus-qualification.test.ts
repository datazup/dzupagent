import { describe, expect, it } from "vitest";

import {
  FLOW_CORPUS_MANIFEST_SCHEMA,
  createFlowCompiler,
  hashFlowCorpusSource,
  measureFlowCorpusRoundTrip,
  parseFlowCorpusManifest,
  qualifyFlowCorpusSources,
  renderFlowCorpusQualificationMarkdown,
} from "../index.js";

const VALID_DSL = [
  "dsl: dzupflow/v1",
  "id: qualified",
  "version: 1",
  "inputs:",
  "  name: string",
  "steps:",
  "  - prompt:",
  "      id: greet",
  '      userPrompt: "Hello {{ inputs.name }}"',
  "      outputKey: greeting",
].join("\n");

const compiler = createFlowCompiler({
  toolResolver: { resolve: () => null, listAvailable: () => [] },
});

describe("flow corpus qualification", () => {
  it("parses an explicit hash-pinned manifest", () => {
    const sha256 = hashFlowCorpusSource(VALID_DSL);
    expect(
      parseFlowCorpusManifest({
        schema: FLOW_CORPUS_MANIFEST_SCHEMA,
        entries: [
          {
            id: "qualified",
            path: "qualified.yaml",
            sha256,
            qualification: "compile-example",
          },
        ],
      }),
    ).toEqual({
      schema: FLOW_CORPUS_MANIFEST_SCHEMA,
      entries: [
        {
          id: "qualified",
          path: "qualified.yaml",
          sha256,
          qualification: "compile-example",
        },
      ],
    });
  });

  it("passes only when every source is strict-ready and hash-matched", async () => {
    const sha256 = hashFlowCorpusSource(VALID_DSL);
    const report = await qualifyFlowCorpusSources(
      [
        {
          id: "qualified",
          path: "qualified.yaml",
          sha256,
          qualification: "compile-example",
          source: VALID_DSL,
        },
      ],
      compiler,
    );
    expect(report.passed).toBe(true);
    expect(report.summary).toEqual({
      total: 1,
      ready: 1,
      changesRequired: 0,
      invalid: 0,
      hashMismatches: 0,
      compileReady: 1,
      compileFailed: 0,
      authoringOnly: 0,
    });
    expect(renderFlowCorpusQualificationMarkdown(report)).toContain(
      "Status: **passed**",
    );
  });

  it("fails closed on source-hash drift", async () => {
    const report = await qualifyFlowCorpusSources(
      [
        {
          id: "qualified",
          path: "qualified.yaml",
          sha256: "0".repeat(64),
          qualification: "compile-example",
          source: VALID_DSL,
        },
      ],
      compiler,
    );
    expect(report.passed).toBe(false);
    expect(report.summary.hashMismatches).toBe(1);
  });

  it("keeps authoring-only examples visible without claiming compilation", async () => {
    const report = await qualifyFlowCorpusSources(
      [
        {
          id: "qualified",
          path: "qualified.yaml",
          sha256: hashFlowCorpusSource(VALID_DSL),
          qualification: "authoring-only",
          source: VALID_DSL,
        },
      ],
      compiler,
    );

    expect(report.passed).toBe(true);
    expect(report.summary).toMatchObject({
      compileReady: 0,
      compileFailed: 0,
      authoringOnly: 1,
    });
    expect(report.items[0]).toMatchObject({
      qualification: "authoring-only",
      compileStatus: "not-required",
      compileDiagnosticCodes: [],
    });
  });

  describe("formatter round trip", () => {
    // A multi-line description is the case that used to emit the block scalar
    // header as the quoted VALUE `description: "|"`, making the formatter's own
    // output unparsable. VALID_DSL (single-line, no description) is the
    // ACCEPTING control: it holds every other dimension constant, so a
    // "not-reparsable" assertion cannot pass merely because everything fails.
    const MULTILINE_DESCRIPTION_DSL = [
      "dsl: dzupflow/v1",
      "id: described",
      "description: |",
      "  First line of prose.",
      "  Second line of prose.",
      "version: 1",
      "steps:",
      "  - prompt:",
      "      id: greet",
      '      userPrompt: "Hello"',
      "      outputKey: greeting",
    ].join("\n");

    it("reports a faithfully formatted document as lossless", () => {
      expect(measureFlowCorpusRoundTrip(VALID_DSL)).toEqual({
        status: "lossless",
        lossPaths: [],
      });
    });

    it("keeps a multi-line description reparsable", () => {
      // Regression pin: this returned "not-reparsable" before the block-scalar
      // header was emitted raw.
      expect(measureFlowCorpusRoundTrip(MULTILINE_DESCRIPTION_DSL).status).toBe(
        "lossless",
      );
    });

    // Node-level prose uses the same raw block-scalar writer as document prose.
    const NODE_MULTILINE_DSL = [
      "dsl: dzupflow/v1",
      "id: lossy-node-prose",
      "version: 1",
      "steps:",
      "  - prompt:",
      "      id: greet",
      "      userPrompt: |",
      "        Line one of prose.",
      "        Line two of prose.",
      "      outputKey: greeting",
    ].join("\n");

    it("round-trips node-level multiline prose without JSON escape drift", () => {
      expect(measureFlowCorpusRoundTrip(NODE_MULTILINE_DSL)).toEqual({
        status: "lossless",
        lossPaths: [],
      });
    });

    const DERIVED_LINEAGE_DSL = [
      "dsl: dzupflow/v1",
      "id: derived-lineage",
      "version: 1",
      "uses:",
      "  sdlc: dzup.sdlc@1",
      "inputs:",
      "  validationItems:",
      "    type: array",
      "    required: true",
      "steps:",
      "  - sdlc.batch_validation:",
      "      id: validation_batch",
      "      items: inputs.validationItems",
      "      concurrency: 2",
      "      failFast: false",
      "      output: validationStatuses",
    ].join("\n");

    it("round-trips generated composite lineage losslessly", () => {
      // Regression: meta.fragmentExpansions is emitted as an inline JSON array.
      // The mini-YAML flow-sequence parser used to comma-split it into garbage
      // strings, so this lineage was classified lossy. It must now survive.
      expect(measureFlowCorpusRoundTrip(DERIVED_LINEAGE_DSL)).toEqual({
        status: "lossless",
        lossPaths: [],
      });
    });

    it("counts generated composite lineage as lossless", async () => {
      const report = await qualifyFlowCorpusSources(
        [
          {
            id: "derived-lineage",
            path: "derived-lineage.yaml",
            sha256: hashFlowCorpusSource(DERIVED_LINEAGE_DSL),
            qualification: "compile-example",
            source: DERIVED_LINEAGE_DSL,
          },
        ],
        compiler,
      );

      expect(report.passed).toBe(true);
      expect(report.roundTrip).toMatchObject({ lossless: 1, lossy: 0 });
      expect(report.items[0]).toMatchObject({
        roundTripStatus: "lossless",
        roundTripLossPaths: [],
      });
      expect(renderFlowCorpusQualificationMarkdown(report)).toContain(
        "Lossless: **1 / 1**",
      );
    });

    it("tracks a non-lossless round trip without failing qualification", async () => {
      // The round-trip metric is reported, never gated. An authoring-only entry
      // whose source does not parse is counted as non-lossless while the report
      // still passes — proving the metric cannot flip `passed`.
      const report = await qualifyFlowCorpusSources(
        [
          {
            id: "unparsable",
            path: "unparsable.yaml",
            sha256: hashFlowCorpusSource("not: a: valid: flow"),
            qualification: "authoring-only",
            source: "not: a: valid: flow",
          },
        ],
        compiler,
      );

      expect(report.roundTrip).toMatchObject({
        lossless: 0,
        unparsableSource: 1,
      });
      expect(renderFlowCorpusQualificationMarkdown(report)).toContain(
        "Lossless: **0 / 1**",
      );
    });

    it("classifies a source that does not parse without blaming the formatter", () => {
      expect(measureFlowCorpusRoundTrip("not: a: valid: flow")).toEqual({
        status: "unparsable-source",
        lossPaths: [],
      });
    });

    it("reports round-trip counts without gating the qualification verdict", async () => {
      const report = await qualifyFlowCorpusSources(
        [
          {
            id: "qualified",
            path: "qualified.yaml",
            sha256: hashFlowCorpusSource(VALID_DSL),
            qualification: "compile-example",
            source: VALID_DSL,
          },
        ],
        compiler,
      );

      expect(report.passed).toBe(true);
      expect(report.roundTrip).toEqual({
        total: 1,
        lossless: 1,
        lossy: 0,
        notReparsable: 0,
        unparsableSource: 0,
        minLossless: null,
        belowMinLossless: false,
      });
      expect(report.items[0]).toMatchObject({
        roundTripStatus: "lossless",
        roundTripLossPaths: [],
      });
      expect(renderFlowCorpusQualificationMarkdown(report)).toContain(
        "Lossless: **1 / 1**",
      );
    });

    describe("lossless ratchet", () => {
      // An unparsable authoring-only entry is the fixture of choice: it is
      // non-lossless while every OTHER admission dimension still passes
      // (ready, hash-matched, no compile required). So `passed` here can only
      // be flipped by the ratchet — nothing else is failing.
      const NON_LOSSLESS = {
        id: "unparsable",
        path: "unparsable.yaml",
        sha256: hashFlowCorpusSource("not: a: valid: flow"),
        qualification: "authoring-only" as const,
        source: "not: a: valid: flow",
      };
      // The ACCEPTING control on the same axis: parses and round-trips
      // losslessly, so a floor of 1 is met rather than breached.
      const LOSSLESS = {
        id: "qualified",
        path: "qualified.yaml",
        sha256: hashFlowCorpusSource(VALID_DSL),
        qualification: "compile-example" as const,
        source: VALID_DSL,
      };

      it("stays ungated when no floor is supplied", async () => {
        const report = await qualifyFlowCorpusSources([NON_LOSSLESS], compiler);

        // 0 lossless yet still passing — this is the default contract.
        expect(report.roundTrip.lossless).toBe(0);
        expect(report.passed).toBe(true);
        expect(report.roundTrip.minLossless).toBeNull();
        expect(report.roundTrip.belowMinLossless).toBe(false);
        expect(renderFlowCorpusQualificationMarkdown(report)).toContain(
          "measured, not gated",
        );
      });

      it("fails when lossless count falls below the floor", async () => {
        const report = await qualifyFlowCorpusSources([NON_LOSSLESS], compiler, {
          minLossless: 1,
        });

        expect(report.roundTrip).toMatchObject({
          lossless: 0,
          minLossless: 1,
          belowMinLossless: true,
        });
        expect(report.passed).toBe(false);
        // Every non-round-trip dimension is still clean, proving the ratchet —
        // not some unrelated failure — is what flipped the verdict.
        expect(report.summary).toMatchObject({
          ready: 1,
          changesRequired: 0,
          invalid: 0,
          hashMismatches: 0,
          compileFailed: 0,
        });
        const markdown = renderFlowCorpusQualificationMarkdown(report);
        expect(markdown).toContain("gated: minimum 1 lossless");
        expect(markdown).toContain("BELOW the required 1");
      });

      it("passes when the floor is exactly met", async () => {
        const report = await qualifyFlowCorpusSources([LOSSLESS], compiler, {
          minLossless: 1,
        });

        expect(report.roundTrip).toMatchObject({
          lossless: 1,
          minLossless: 1,
          belowMinLossless: false,
        });
        expect(report.passed).toBe(true);
      });

      it("passes when a floor of zero is supplied", async () => {
        // Distinguishes an explicit 0 from an omitted option: 0 is a real,
        // enforced floor that happens to be satisfiable, not "gating off".
        const report = await qualifyFlowCorpusSources([NON_LOSSLESS], compiler, {
          minLossless: 0,
        });

        expect(report.passed).toBe(true);
        expect(report.roundTrip.minLossless).toBe(0);
        expect(renderFlowCorpusQualificationMarkdown(report)).toContain(
          "gated: minimum 0 lossless",
        );
      });

      it("rejects a floor that is not a non-negative integer", async () => {
        await expect(
          qualifyFlowCorpusSources([LOSSLESS], compiler, { minLossless: -1 }),
        ).rejects.toThrow("minLossless must be a non-negative integer");
        await expect(
          qualifyFlowCorpusSources([LOSSLESS], compiler, { minLossless: 1.5 }),
        ).rejects.toThrow("minLossless must be a non-negative integer");
      });
    });
  });

  it("fails closed when a compile-example cannot compile", async () => {
    const source = [
      "dsl: dzupflow/v1",
      "id: unresolved-parent",
      "version: 1",
      "steps:",
      "  - subflow:",
      "      id: missing-child",
      "      flowRef: unresolved-child",
    ].join("\n");
    const report = await qualifyFlowCorpusSources(
      [
        {
          id: "unresolved-parent",
          path: "unresolved-parent.yaml",
          sha256: hashFlowCorpusSource(source),
          qualification: "compile-example",
          source,
        },
      ],
      compiler,
    );

    expect(report.passed).toBe(false);
    expect(report.summary.compileFailed).toBe(1);
    expect(report.items[0]).toMatchObject({
      compileStatus: "failed",
      compileDiagnosticCodes: ["EMPTY_TARGET_ARTIFACT"],
    });
  });
});
