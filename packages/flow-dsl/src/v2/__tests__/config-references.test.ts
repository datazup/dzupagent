import { describe, expect, it } from "vitest";

import {
  DSL_V2_CONFIG_REFERENCE_KINDS,
  findConfigLiteralSecret,
  lowerDslV2Document,
  parseV2ConfigReferences,
} from "../index.js";
import type { DslDiagnostic } from "../../types.js";

function document(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dsl: "dzupflow/v2",
    id: "config-refs",
    version: "2.0.0",
    steps: [
      { id: "seed", use: "core.set@1", with: { assign: { ready: true } } },
      { id: "done", use: "core.complete@1", with: { result: "accepted" } },
    ],
    ...extra,
  };
}

// Secret-shaped literals are assembled at run time so no credential-looking
// string is committed to source (and no push-protection scanner trips).
const join = (...parts: string[]): string => parts.join("");
const SECRET_LITERALS: readonly (readonly [string, string])[] = [
  ["openai-style key", join("sk", "-", "proj", "A1b2C3d4E5f6G7h8")],
  ["stripe live key", join("sk", "_live_", "A1b2C3d4E5f6")],
  ["stripe test key", join("sk", "_test_", "A1b2C3d4E5f6")],
  ["stripe restricted key", join("rk", "_live_", "A1b2C3d4E5f6")],
  ["github token", join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0")],
  ["github oauth token", join("gh", "o_", "A1b2C3d4E5f6G7h8I9j0")],
  ["github fine-grained pat", join("github", "_pat_", "A1b2C3d4E5f6")],
  ["gitlab pat", join("gl", "pat-", "A1b2C3d4E5f6G7h8")],
  ["slack token", join("xo", "xb-", "1234-5678-abcd")],
  ["aws access key", join("AK", "IA", "ABCDEFGHIJ234567")],
  ["aws session key", join("AS", "IA", "ABCDEFGHIJ234567")],
  ["google api key", join("AI", "za", "A".repeat(20), "b".repeat(14), "9")],
  ["pem header", join("-----", "BEGIN PRIVATE KEY", "-----")],
  ["bearer credential", join("Bea", "rer ", "abc.def")],
  ["basic credential", join("Ba", "sic ", "dXNlcjpwYXNz")],
  ["jwt", join("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxIn0", ".", "c2lnbmF0dXJl")],
  ["url userinfo", join("https://", "user", ":", "hunter2", "@example.test/db")],
  ["long opaque run", join("a1".repeat(16), "Z9")],
];

function codes(diagnostics: readonly DslDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

describe("dzupflow/v2 config references (DZA-DSL-V2-CONFIG-S2-20261007-S2A)", () => {
  it("gate 1: declares sorted, frozen references and keeps config out of the lowered v1 document", () => {
    const result = lowerDslV2Document(
      document({
        config: {
          primaryModel: {
            kind: "model",
            description: "model used by the draft step",
          },
          llmProvider: { kind: "provider" },
          deployEnv: { kind: "environment" },
        },
      })
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.metadata?.configReferences).toEqual([
      { name: "deployEnv", kind: "environment" },
      { name: "llmProvider", kind: "provider" },
      {
        name: "primaryModel",
        kind: "model",
        description: "model used by the draft step",
      },
    ]);
    expect(Object.isFrozen(result.metadata?.configReferences)).toBe(true);
    expect(Object.isFrozen(result.metadata?.configReferences?.[0])).toBe(true);
    expect(result.raw).not.toHaveProperty("config");
  });

  it("gate 1: an empty config block declares no references", () => {
    const result = lowerDslV2Document(document({ config: {} }));
    expect(result.ok).toBe(true);
    expect(result.metadata?.configReferences).toEqual([]);
    expect(result.raw).not.toHaveProperty("config");
  });

  it("exports the closed kind list", () => {
    expect(DSL_V2_CONFIG_REFERENCE_KINDS).toEqual([
      "model",
      "provider",
      "environment",
    ]);
    expect(Object.isFrozen(DSL_V2_CONFIG_REFERENCE_KINDS)).toBe(true);
  });

  describe("gate 2: no secret value can enter the AST", () => {
    for (const [label, literal] of SECRET_LITERALS) {
      it(`detects ${label}`, () => {
        expect(findConfigLiteralSecret(literal)).toEqual(expect.any(String));
        expect(findConfigLiteralSecret(literal)).not.toContain(literal);
      });

      it(`refuses ${label} as a scalar entry`, () => {
        const result = lowerDslV2Document(
          document({ config: { apiKey: literal } })
        );
        expect(result.ok).toBe(false);
        expect(result.raw).toBeNull();
        expect(result.metadata).toBeNull();
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "CONFIG_LITERAL_SECRET",
            path: "root.config.apiKey",
          })
        );
        expect(JSON.stringify(result)).not.toContain(literal);
      });

      it(`refuses ${label} under a value key`, () => {
        const result = lowerDslV2Document(
          document({ config: { primaryModel: { kind: "model", value: literal } } })
        );
        expect(result.ok).toBe(false);
        expect(result.raw).toBeNull();
        expect(result.metadata).toBeNull();
        expect(codes(result.diagnostics)).toContain("CONFIG_LITERAL_SECRET");
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "CONFIG_REFERENCE_INVALID",
            path: "root.config.primaryModel.value",
          })
        );
        expect(JSON.stringify(result)).not.toContain(literal);
      });

      it(`refuses ${label} in a description`, () => {
        const result = lowerDslV2Document(
          document({
            config: { primaryModel: { kind: "model", description: literal } },
          })
        );
        expect(result.ok).toBe(false);
        expect(result.raw).toBeNull();
        expect(result.metadata).toBeNull();
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "CONFIG_LITERAL_SECRET",
            path: "root.config.primaryModel.description",
          })
        );
        expect(JSON.stringify(result)).not.toContain(literal);
      });
    }

    it("refuses a non-secret scalar entry as a literal value", () => {
      const result = lowerDslV2Document(
        document({ config: { primaryModel: "gpt-like-model" } })
      );
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "CONFIG_LITERAL_VALUE",
          path: "root.config.primaryModel",
        })
      );
    });

    it("refuses an array entry as a literal value", () => {
      const result = lowerDslV2Document(
        document({ config: { primaryModel: ["a", "b"] } })
      );
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "CONFIG_LITERAL_VALUE",
          path: "root.config.primaryModel",
        })
      );
    });

    for (const key of ["value", "default", "apiKey", "token", "secret"]) {
      it(`refuses the value-carrying entry key "${key}"`, () => {
        const result = lowerDslV2Document(
          document({ config: { primaryModel: { kind: "model", [key]: "x" } } })
        );
        expect(result.ok).toBe(false);
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "CONFIG_REFERENCE_INVALID",
            path: `root.config.primaryModel.${key}`,
          })
        );
      });
    }

    it("does not echo a secret-shaped reference name", () => {
      const literal = join("gh", "p_", "A1b2C3d4E5f6G7h8I9j0");
      const result = lowerDslV2Document(
        document({ config: { [literal]: { kind: "model" } } })
      );
      expect(result.ok).toBe(false);
      expect(codes(result.diagnostics)).toContain("CONFIG_LITERAL_SECRET");
      expect(JSON.stringify(result)).not.toContain(literal);
    });

    it("leaves ordinary names and descriptions alone", () => {
      expect(findConfigLiteralSecret("primaryModel")).toBeUndefined();
      expect(findConfigLiteralSecret("model used by the draft step")).toBeUndefined();
      expect(findConfigLiteralSecret("a".repeat(40))).toBeUndefined();
      expect(findConfigLiteralSecret("https://example.test/db")).toBeUndefined();
    });
  });

  describe("gate 3: closed shape", () => {
    const refusals: readonly (readonly [string, unknown, string, string])[] = [
      ["unknown kind", { m: { kind: "database" } }, "CONFIG_REFERENCE_INVALID", "root.config.m.kind"],
      ["missing kind", { m: {} }, "CONFIG_REFERENCE_INVALID", "root.config.m.kind"],
      ["bad name", { "Bad-Name": { kind: "model" } }, "CONFIG_REFERENCE_INVALID", "root.config.Bad-Name"],
      ["over-long name", { ["a".repeat(65)]: { kind: "model" } }, "CONFIG_REFERENCE_INVALID", `root.config.${"a".repeat(65)}`],
      ["non-object block", ["model"], "INVALID_NODE_SHAPE", "root.config"],
      ["scalar block", "model", "INVALID_NODE_SHAPE", "root.config"],
      ["over-long description", { m: { kind: "model", description: "d".repeat(201) } }, "CONFIG_REFERENCE_INVALID", "root.config.m.description"],
      ["non-string description", { m: { kind: "model", description: 7 } }, "CONFIG_REFERENCE_INVALID", "root.config.m.description"],
      ["unknown entry key", { m: { kind: "model", region: "eu" } }, "CONFIG_REFERENCE_INVALID", "root.config.m.region"],
    ];
    for (const [label, config, code, path] of refusals) {
      it(`refuses ${label}`, () => {
        const result = lowerDslV2Document(document({ config }));
        expect(result.ok).toBe(false);
        expect(result.raw).toBeNull();
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({ code, path })
        );
      });
    }

    it("parseV2ConfigReferences returns undefined when config is absent", () => {
      const diagnostics: DslDiagnostic[] = [];
      expect(parseV2ConfigReferences(undefined, diagnostics)).toBeUndefined();
      expect(diagnostics).toEqual([]);
    });
  });

  describe("gate 4: old documents still parse", () => {
    it("metadata for a document without config carries no configReferences key", () => {
      const result = lowerDslV2Document(document());
      expect(result.ok).toBe(true);
      expect(result.metadata).not.toBeNull();
      expect(Object.keys(result.metadata!)).not.toContain("configReferences");
      expect(Object.keys(result.metadata!)).toEqual([
        "schema",
        "authoredDsl",
        "authoredVersion",
        "canonicalDsl",
        "canonicalVersion",
        "primitiveImportMode",
        "primitiveImports",
        "resolvedImportLock",
        "importLockChainEntry",
        "stepLineage",
        "primitiveBindings",
        "policyNarrowings",
        "retryPolicies",
        "terminalCatches",
        "multiPortSaves",
      ]);
    });

    it("declaring config changes neither the lowered v1 document nor other metadata", () => {
      const plain = lowerDslV2Document(document());
      const declared = lowerDslV2Document(
        document({ config: { primaryModel: { kind: "model" } } })
      );
      expect(declared.raw).toEqual(plain.raw);
      const { configReferences, ...rest } = declared.metadata!;
      expect(configReferences).toHaveLength(1);
      expect(rest).toEqual(plain.metadata);
    });
  });
});
