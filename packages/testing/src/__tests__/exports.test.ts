import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as testingPkg from "../index.js";
import * as securityPkg from "../security/index.js";

interface PackageJson {
  exports?: Record<string, unknown>;
  bin?: Record<string, string>;
}

const expectedCoreConsumerSubpaths = [
  "./events",
  "./llm",
  "./tools",
  "./identity",
  "./persistence",
  "./plugins",
  "./pipeline",
  "./mcp",
] as const;

const coreSubpathImporters: Record<
  (typeof expectedCoreConsumerSubpaths)[number],
  () => Promise<Record<string, unknown>>
> = {
  "./events": () => import("@dzupagent/core/events"),
  "./llm": () => import("@dzupagent/core/llm"),
  "./tools": () => import("@dzupagent/core/tools"),
  "./identity": () => import("@dzupagent/core/identity"),
  "./persistence": () => import("@dzupagent/core/persistence"),
  "./plugins": () => import("@dzupagent/core/plugins"),
  "./pipeline": () => import("@dzupagent/core/pipeline"),
  "./mcp": () => import("@dzupagent/core/mcp"),
};

// ---------------------------------------------------------------------------
// Top-level package exports
// ---------------------------------------------------------------------------

describe("Package exports — @dzupagent/testing", () => {
  it("should export MockSkillStepResolver class", () => {
    expect(testingPkg.MockSkillStepResolver).toBeDefined();
    expect(typeof testingPkg.MockSkillStepResolver).toBe("function");
  });

  it("should export runSecuritySuite function", () => {
    expect(testingPkg.runSecuritySuite).toBeDefined();
    expect(typeof testingPkg.runSecuritySuite).toBe("function");
  });

  it("should export runSdlcMvpEvidenceReport function", () => {
    expect(testingPkg.runSdlcMvpEvidenceReport).toBeDefined();
    expect(typeof testingPkg.runSdlcMvpEvidenceReport).toBe("function");
  });

  it("should export INJECTION_SUITE array", () => {
    expect(testingPkg.INJECTION_SUITE).toBeDefined();
    expect(Array.isArray(testingPkg.INJECTION_SUITE)).toBe(true);
    expect(testingPkg.INJECTION_SUITE.length).toBeGreaterThan(0);
  });

  it("should export ESCALATION_SUITE array", () => {
    expect(testingPkg.ESCALATION_SUITE).toBeDefined();
    expect(Array.isArray(testingPkg.ESCALATION_SUITE)).toBe(true);
    expect(testingPkg.ESCALATION_SUITE.length).toBeGreaterThan(0);
  });

  it("should export POISONING_SUITE array", () => {
    expect(testingPkg.POISONING_SUITE).toBeDefined();
    expect(Array.isArray(testingPkg.POISONING_SUITE)).toBe(true);
    expect(testingPkg.POISONING_SUITE.length).toBeGreaterThan(0);
  });

  it("should export ESCAPE_SUITE array", () => {
    expect(testingPkg.ESCAPE_SUITE).toBeDefined();
    expect(Array.isArray(testingPkg.ESCAPE_SUITE)).toBe(true);
    expect(testingPkg.ESCAPE_SUITE.length).toBeGreaterThan(0);
  });

  it("should export exactly the expected named exports", () => {
    const exportNames = Object.keys(testingPkg).sort();
    expect(exportNames).toEqual([
      "ESCALATION_SUITE",
      "ESCAPE_SUITE",
      "ExactMatchScorer",
      "INJECTION_SUITE",
      "LlmJudgeScorer",
      "LlmRecorder",
      "MockSkillStepResolver",
      "POISONING_SUITE",
      "RegexScorer",
      "buildStubAnthropicClient",
      "createDemoEvalSuite",
      "createLivePostgresClient",
      "createLiveRedisClient",
      "createSdlcValidationRuntimeToolHandlers",
      "runEvalSuite",
      "runSdlcMvpEvidenceReport",
      "runSecuritySuite",
      "shapeCommandOutputsForBatchValidation",
      "shapeSdlcMvpEvidenceCommandOutputs",
      "waitForCondition",
      "withRecordedRegistry",
    ]);
  });

  it("should export createLiveRedisClient and createLivePostgresClient functions", () => {
    expect(typeof testingPkg.createLiveRedisClient).toBe("function");
    expect(typeof testingPkg.createLivePostgresClient).toBe("function");
  });

  it("should expose the documented vitest setup subpath", () => {
    const rawPackageJson = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf-8"
    );
    const packageJson = JSON.parse(rawPackageJson) as PackageJson;

    expect(packageJson.exports?.["./vitest-llm-setup"]).toEqual({
      import: "./dist/vitest-llm-setup.js",
      types: "./dist/vitest-llm-setup.d.ts",
    });
  });

  it("should expose the documented SDLC MVP evidence binary", () => {
    const rawPackageJson = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf-8"
    );
    const packageJson = JSON.parse(rawPackageJson) as PackageJson;

    expect(packageJson.bin?.["dzupagent-sdlc-mvp-evidence"]).toBe(
      "./dist/bin/sdlc-mvp-evidence.js"
    );
  });

  it("should emit the documented SDLC MVP evidence binary artifact after build", () => {
    const artifactUrl = new URL(
      "../../dist/bin/sdlc-mvp-evidence.js",
      import.meta.url
    );

    expect(existsSync(artifactUrl)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Consumer dependency exports
// ---------------------------------------------------------------------------

describe("Package exports — @dzupagent/core consumer subpaths", () => {
  it("should declare the expected core subpaths consumed by testing package users", () => {
    const rawPackageJson = readFileSync(
      new URL("../../../core/package.json", import.meta.url),
      "utf-8"
    );
    const packageJson = JSON.parse(rawPackageJson) as PackageJson;

    for (const subpath of expectedCoreConsumerSubpaths) {
      expect(packageJson.exports?.[subpath]).toEqual({
        import: expect.stringMatching(/^\.\/dist\/.+\.js$/),
        types: expect.stringMatching(/^\.\/dist\/.+\.d\.ts$/),
      });
    }
  });

  it("should import the expected core subpaths from built package exports", async () => {
    const modules = await Promise.all(
      expectedCoreConsumerSubpaths.map(async (subpath) => {
        const moduleExports = await coreSubpathImporters[subpath]();
        return [subpath, moduleExports] as const;
      })
    );

    for (const [subpath, moduleExports] of modules) {
      expect(Object.keys(moduleExports), subpath).not.toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Security sub-package exports
// ---------------------------------------------------------------------------

describe("Package exports — security/index", () => {
  it("should export runSecuritySuite", () => {
    expect(securityPkg.runSecuritySuite).toBeDefined();
    expect(typeof securityPkg.runSecuritySuite).toBe("function");
  });

  it("should export all four suites", () => {
    expect(securityPkg.INJECTION_SUITE).toBeDefined();
    expect(securityPkg.ESCALATION_SUITE).toBeDefined();
    expect(securityPkg.POISONING_SUITE).toBeDefined();
    expect(securityPkg.ESCAPE_SUITE).toBeDefined();
  });

  it("security suites should be the same references as top-level exports", () => {
    expect(securityPkg.INJECTION_SUITE).toBe(testingPkg.INJECTION_SUITE);
    expect(securityPkg.ESCALATION_SUITE).toBe(testingPkg.ESCALATION_SUITE);
    expect(securityPkg.POISONING_SUITE).toBe(testingPkg.POISONING_SUITE);
    expect(securityPkg.ESCAPE_SUITE).toBe(testingPkg.ESCAPE_SUITE);
  });

  it("runSecuritySuite should be the same reference", () => {
    expect(securityPkg.runSecuritySuite).toBe(testingPkg.runSecuritySuite);
  });
});

// ---------------------------------------------------------------------------
// MockSkillStepResolver instantiation via export
// ---------------------------------------------------------------------------

describe("MockSkillStepResolver — instantiation via export", () => {
  it("should create a new instance with empty calls", () => {
    const resolver = new testingPkg.MockSkillStepResolver();
    expect(resolver.calls).toEqual([]);
  });

  it("should support registerText and resolve through the exported class", async () => {
    const resolver = new testingPkg.MockSkillStepResolver();
    resolver.registerText("hello", "world");
    const step = await resolver.resolve("hello");
    const result = await step.execute({});
    expect(result).toEqual({ hello: "world" });
  });
});
