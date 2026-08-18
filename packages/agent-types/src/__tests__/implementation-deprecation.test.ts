import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import * as implementationRuntime from "../implementation.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const implementationEntrypoint = join(sourceRoot, "implementation.ts");
const rootEntrypoint = join(sourceRoot, "index.ts");

const implementationExports = [
  "IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION",
  "EvaluationDecision",
  "EvaluationDecisionKind",
  "ImplementationBatch",
  "ImplementationPlan",
  "ImplementationPlanPolicy",
  "ImplementationRepoRef",
  "ImplementationRunStatus",
  "ImplementationTask",
  "MapImplementationTaskToAgentTaskInput",
  "PlanValidationIssue",
  "PlanValidationResult",
  "ScheduledBatch",
  "ScheduledRepoLane",
  "TaskAttempt",
  "buildImplementationSchedule",
  "mapImplementationTaskToAgentTask",
  "validateImplementationPlan",
] as const;

function createPublicApiProgram(): {
  checker: ts.TypeChecker;
  program: ts.Program;
} {
  const program = ts.createProgram(
    [implementationEntrypoint, rootEntrypoint],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
    },
  );
  return {
    checker: program.getTypeChecker(),
    program,
  };
}

function exportedSymbols(
  program: ts.Program,
  checker: ts.TypeChecker,
  entrypoint: string,
): readonly ts.Symbol[] {
  const sourceFile = program.getSourceFile(entrypoint);
  expect(sourceFile, `missing source file ${entrypoint}`).toBeDefined();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile!);
  expect(moduleSymbol, `missing module symbol ${entrypoint}`).toBeDefined();
  return checker.getExportsOfModule(moduleSymbol!);
}

function targetSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function deprecationText(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const deprecated = targetSymbol(symbol, checker)
    .getJsDocTags(checker)
    .find((tag) => tag.name === "deprecated");
  if (!deprecated?.text) return "";
  return typeof deprecated.text === "string"
    ? deprecated.text
    : deprecated.text.map((part) => part.text).join("");
}

describe("implementation compatibility deprecation", () => {
  let publicApi: ReturnType<typeof createPublicApiProgram>;

  beforeAll(() => {
    publicApi = createPublicApiProgram();
  }, 60_000);

  it("classifies every public subpath export and gives it the migration diagnostic", () => {
    const { checker, program } = publicApi;
    const symbols = exportedSymbols(
      program,
      checker,
      implementationEntrypoint,
    );

    expect(symbols.map((symbol) => symbol.name).sort()).toEqual(
      [...implementationExports].sort(),
    );
    for (const symbol of symbols) {
      const message = deprecationText(symbol, checker);
      expect(message, `${symbol.name} is missing @deprecated`).toContain(
        "Repository-delivery compatibility only",
      );
      expect(message).toContain("Scripts DeliveryBundle/ExecutionPlan");
      expect(message).toContain("AgentTask");
    }
  });

  it("propagates deprecation to the root-exported schema constant", () => {
    const { checker, program } = publicApi;
    const rootConstant = exportedSymbols(program, checker, rootEntrypoint)
      .find(
        (symbol) =>
          symbol.name === "IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION",
      );

    expect(rootConstant).toBeDefined();
    expect(deprecationText(rootConstant!, checker)).toContain(
      "Repository-delivery compatibility only",
    );
  });

  it("preserves the compatibility runtime export set", () => {
    expect(Object.keys(implementationRuntime).sort()).toEqual([
      "IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION",
      "buildImplementationSchedule",
      "mapImplementationTaskToAgentTask",
      "validateImplementationPlan",
    ]);
  });
});
