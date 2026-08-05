import { describe, expect, it } from "vitest";

import {
  FLOW_CORPUS_MANIFEST_SCHEMA,
  createFlowCompiler,
  hashFlowCorpusSource,
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
