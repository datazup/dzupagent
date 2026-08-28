// ARCH27-T-01: the v2 canonicalize -> parseYamlSubset round trip must be
// closed, and canonical digests must be locale-independent.
//
// The GOLDEN digests below were generated from the pre-change implementation
// (yaml.stringify without subset constraints, localeCompare key ordering) at
// dzupagent 242c1d97. They pin that the subset-constrained emitter options and
// the localeCompare -> UTF-16 comparator swap leave every representative
// document's persisted digests byte-identical.
import { describe, expect, it } from "vitest";

import type { DslV2ExternalImportCatalogs } from "../index.js";
import { parseYamlSubset } from "../mini-yaml.js";
import { sha256, stableStringify } from "../v2-authoring/canonical.js";
import { formatDslV2Document, importDslV2Source } from "../v2-authoring.js";

const CATALOGS: DslV2ExternalImportCatalogs = {
  profiles: [
    { ref: "research-fast@1", semanticHash: `sha256:${"1".repeat(64)}` },
  ],
};

const BASIC = {
  steps: [
    {
      with: { result: "done" },
      use: "core.complete@1",
      id: "done",
    },
  ],
  version: "2.0.0",
  id: "golden-basic",
  dsl: "dzupflow/v2",
};

const RICH = {
  dsl: "dzupflow/v2",
  id: "golden-rich",
  version: "2.0.0",
  inputs: { score: "number" },
  meta: {
    zulu: "last",
    alpha: "first",
    mixedCase: "b",
    snake_case: "a",
    "dot.key": "c",
    "dash-key": "d",
    note: "colon: inside",
    literalTrue: "true",
    octalish: "030",
    apostrophe: "don't",
    bracket: "[not-json",
    dash: "- leading",
  },
  tags: ["review", "golden"],
  steps: [
    {
      id: "run",
      use: "adapter.run@1",
      with: { provider: "codex", instructions: "Draft." },
      when: { all: [{ gte: [{ ref: "inputs.score" }, 3] }] },
      policy: { requireApproval: true, budgetCents: 25, timeoutMs: 30000 },
      retry: {
        maxAttempts: 3,
        match: ["ADAPTER_FAILED"],
        backoff: {
          maxMs: 20,
          initialMs: 10,
          jitter: "full",
          strategy: "exponential",
        },
      },
      catch: [{ action: "continue", match: ["ADAPTER_CANCELLED"] }],
      save: { result: "state.result" },
    },
  ],
};

const IMPORTS_SOURCE = `dsl: dzupflow/v2
id: golden-imports
version: 2.0.0
imports:
  profiles:
    - ref: research-fast@1
      semanticHash: sha256:${"1".repeat(64)}
steps:
  - id: done
    use: core.complete@1
    with:
      result: accepted
`;

const GOLDEN = {
  basic: {
    canonicalSourceSha256:
      "sha256:55e55e837601077203b2c9efd6d5c274e9f60e5b6bebc35a00ca2382d3ceba52",
    semanticSha256:
      "sha256:c171550810b406a2cb24e21c6137ef98688cb5f28838136309325cc05df07ce5",
    resolvedImportLockSha256:
      "sha256:46ad6a61a5ff1fc8b432d8a8dded772bf8459bdc3c526442c29f4c3af4efeedb",
  },
  rich: {
    canonicalSourceSha256:
      "sha256:ab436e777c520a7954759e7b3039ab2fe7c651e65099bb25cccec77105ab088a",
    semanticSha256:
      "sha256:364569df9fa56aeecf096c40c33256417fa5dc8884d262d5b59be46fe7df3fef",
    resolvedImportLockSha256:
      "sha256:2e41b8edb99efbe64281305df18cac25b091fffcd92aae729ef928dc8b01b189",
  },
  imports: {
    canonicalSourceSha256:
      "sha256:33ee4c3ebf9536b754c4dd4ab776820d6e8e7abcda8ac7844293f2f90ebcf928",
    semanticSha256:
      "sha256:b7bc1c7d9f3db0ed644154205bc8221b313ee1320a5fca4a0ee4caf71ddde826",
    resolvedImportLockSha256:
      "sha256:1f03de11c64a1a081e4b3f46c6a124aff686c016928e23f1eaf060d0f52b6521",
  },
} as const;

function corpusResults() {
  return {
    basic: formatDslV2Document(BASIC),
    rich: formatDslV2Document(RICH),
    imports: importDslV2Source(IMPORTS_SOURCE, { importCatalogs: CATALOGS }),
  };
}

describe("v2 canonical round-trip (ARCH27-T-01)", () => {
  it("keeps every golden fixture digest byte-identical to the pre-change pins", () => {
    const results = corpusResults();
    for (const name of ["basic", "rich", "imports"] as const) {
      const result = results[name];
      expect(result, name).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(
        {
          canonicalSourceSha256: result.canonicalSourceSha256,
          semanticSha256: result.semanticSha256,
          resolvedImportLockSha256: result.resolvedImportLockSha256,
        },
        name,
      ).toEqual(GOLDEN[name]);
    }
  });

  it("reparses every canonical rendering through parseYamlSubset to the exact canonical document", () => {
    for (const [name, result] of Object.entries(corpusResults())) {
      expect(result, name).toMatchObject({ ok: true });
      if (!result.ok) continue;
      const reparsed = parseYamlSubset(result.canonicalSource);
      expect(reparsed, name).toMatchObject({ ok: true });
      if (!reparsed.ok) continue;
      expect(reparsed.value, name).toEqual(result.document);
    }
  });

  it("round-trips multiline strings that the previous block-scalar emission corrupted", () => {
    // Pre-change, yaml.stringify emitted these as block scalars: `|-` is
    // rejected by parseYamlSubset outright and `|` (clip chomping) silently
    // dropped the trailing newline. Both now emit as double-quoted JSON
    // scalars and round-trip exactly.
    const result = formatDslV2Document({
      dsl: "dzupflow/v2",
      id: "multiline",
      version: "2.0.0",
      steps: [
        {
          id: "run",
          use: "adapter.run@1",
          with: { provider: "codex", instructions: "line1\nline2" },
          save: { result: "state.result" },
        },
        {
          id: "runTrailing",
          use: "adapter.run@1",
          with: { provider: "codex", instructions: "trailing newline\n" },
          save: { result: "state.trailing" },
        },
      ],
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.canonicalSource).not.toContain("|");
    const reparsed = parseYamlSubset(result.canonicalSource);
    expect(reparsed).toMatchObject({ ok: true });
    if (!reparsed.ok) return;
    expect(reparsed.value).toEqual(result.document);
  });

  it("fails closed with V2_AUTHORING_CANONICAL_ROUNDTRIP on keys the subset cannot represent", () => {
    const result = formatDslV2Document({
      dsl: "dzupflow/v2",
      id: "bad-key",
      version: "2.0.0",
      meta: { "my key": true },
      steps: [{ id: "done", use: "core.complete@1", with: { result: "done" } }],
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: "V2_AUTHORING_CANONICAL_ROUNDTRIP" }),
      ],
    });
  });

  it("orders stableStringify keys by UTF-16 code unit, independent of the host locale", () => {
    // localeCompare would order "a" before "B"; UTF-16 code units order "B"
    // (0x42) before "a" (0x61) and "_" (0x5F) before both lowercase letters.
    expect(stableStringify({ a: 1, B: 2, _x: 3 })).toBe('{"B":2,"_x":3,"a":1}');
    expect(sha256(stableStringify({ a: 1, B: 2, _x: 3 }))).toBe(
      sha256(stableStringify({ _x: 3, B: 2, a: 1 })),
    );
  });
});
