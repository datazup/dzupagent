#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distRoot = path.join(repoRoot, "packages", "agent-types", "dist");
const implementationDeclaration = path.join(
  distRoot,
  "implementation.d.ts",
);
const deprecationMarker =
  "@deprecated Repository-delivery compatibility only.";

const expectedExports = [
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
];

function fail(message) {
  throw new Error(
    `AGENT_TYPES_IMPLEMENTATION_DEPRECATION_INVALID: ${message}`,
  );
}

if (!fs.existsSync(implementationDeclaration)) {
  fail("build packages/agent-types before checking declarations");
}

const declaration = fs.readFileSync(implementationDeclaration, "utf8");
for (const exportedName of expectedExports) {
  if (!new RegExp(`\\b${exportedName}\\b`, "u").test(declaration)) {
    fail(`implementation.d.ts is missing ${exportedName}`);
  }
}

const localDeprecations = declaration
  .split(deprecationMarker)
  .length - 1;
if (localDeprecations !== expectedExports.length - 1) {
  fail(
    `implementation.d.ts must carry ${
      expectedExports.length - 1
    } local deprecation markers, found ${localDeprecations}`,
  );
}

const constantReexport = new RegExp(
  "export \\{ [A-Za-z_$][\\w$]* as " +
    "IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION \\} " +
    "from './([^']+)\\.js';",
  "u",
).exec(declaration);
if (!constantReexport) {
  fail("implementation.d.ts must re-export the schema constant");
}

const constantDeclaration = path.join(
  distRoot,
  `${constantReexport[1]}.d.ts`,
);
if (!fs.existsSync(constantDeclaration)) {
  fail(`schema-constant declaration chunk is missing: ${constantDeclaration}`);
}
const constantSource = fs.readFileSync(constantDeclaration, "utf8");
if (
  !constantSource.includes(deprecationMarker) ||
  !constantSource.includes(
    "declare const IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION",
  )
) {
  fail("the schema-constant declaration lost its deprecation diagnostic");
}

process.stdout.write(
  `agent-types implementation deprecation: ok (${expectedExports.length} exports)\n`,
);
