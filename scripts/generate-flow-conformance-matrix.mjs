#!/usr/bin/env node

/**
 * Generates docs/generated/FLOW_NODE_CONFORMANCE_MATRIX.{md,json} from the
 * built flow-compiler, or with --check verifies that the committed artifacts
 * are exactly what the current source would generate.
 *
 * Provenance comes from git, never from the wall clock:
 *   - generate: `git rev-parse --short HEAD` and `git log -1 --format=%cI`.
 *   - --check: the provenance retained in the committed JSON, after verifying
 *     that its revision is a commit in the current history and that its
 *     committedAt is that commit's date. Re-reading HEAD here would make the
 *     artifact stale the moment it is committed, since a commit cannot name
 *     its own hash.
 *
 * Host columns: DZUPAGENT_PIPELINE_HOST_MANIFEST always, then one column per
 * `--host-manifest <path>` (repeatable), each a HostCapabilityManifest JSON
 * file. --check must be given the same --host-manifest arguments the
 * committed artifacts were generated with; `yarn check:flow-conformance`
 * passes none.
 *
 * Usage:
 *   node scripts/generate-flow-conformance-matrix.mjs [--check] [--host-manifest <path>]...
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const MODULE_PATH = join(
  ROOT,
  "packages",
  "flow-compiler",
  "dist",
  "index.js",
);
const OUTPUT_DIR = join(ROOT, "docs", "generated");
const MARKDOWN_PATH = join(OUTPUT_DIR, "FLOW_NODE_CONFORMANCE_MATRIX.md");
const JSON_PATH = join(OUTPUT_DIR, "FLOW_NODE_CONFORMANCE_MATRIX.json");
const HOST_MANIFEST_SCHEMA = "dzupagent.hostCapabilityManifest/v1";

function fail(message) {
  console.error(message);
  process.exit(1);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      "host-manifest": { type: "string", multiple: true, default: [] },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (error) {
  fail(`generate-flow-conformance-matrix: ${error.message}`);
}
const check = args.check;

if (!existsSync(MODULE_PATH)) {
  fail(
    "flow-compiler dist is missing. Run `yarn build --filter=@dzupagent/flow-compiler` before generating the matrix.",
  );
}

const {
  DZUPAGENT_PIPELINE_HOST_MANIFEST,
  TARGET_CAPABILITY_MANIFESTS,
  generateFlowConformanceMatrix,
  renderFlowConformanceMatrixMarkdown,
} = await import(pathToFileURL(MODULE_PATH).href);

function git(gitArgs) {
  try {
    return execFileSync("git", gitArgs, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = error.stderr?.toString().trim();
    throw new Error(
      `git ${gitArgs.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
}

function headProvenance() {
  return {
    sourceRevision: git(["rev-parse", "--short", "HEAD"]),
    committedAt: git(["log", "-1", "--format=%cI", "HEAD"]),
  };
}

function retainedProvenance() {
  if (!existsSync(JSON_PATH)) {
    throw new Error(
      `${JSON_PATH.slice(ROOT.length + 1)} is missing; run \`yarn docs:flow-conformance\`.`,
    );
  }
  let retained;
  try {
    retained = JSON.parse(readFileSync(JSON_PATH, "utf8")).provenance;
  } catch (error) {
    throw new Error(
      `${JSON_PATH.slice(ROOT.length + 1)} is not valid JSON: ${error.message}`,
    );
  }
  if (
    typeof retained?.sourceRevision !== "string" ||
    !/^[0-9a-f]{7,40}$/u.test(retained.sourceRevision) ||
    typeof retained.committedAt !== "string"
  ) {
    throw new Error(
      `${JSON_PATH.slice(ROOT.length + 1)} carries no valid provenance; run \`yarn docs:flow-conformance\`.`,
    );
  }
  let commit;
  try {
    commit = git(["rev-parse", "--verify", `${retained.sourceRevision}^{commit}`]);
    git(["merge-base", "--is-ancestor", commit, "HEAD"]);
  } catch {
    throw new Error(
      `the matrix source revision ${retained.sourceRevision} is not a commit in the current history; run \`yarn docs:flow-conformance\`.`,
    );
  }
  const committedAt = git(["log", "-1", "--format=%cI", commit]);
  if (committedAt !== retained.committedAt) {
    throw new Error(
      `the matrix records committedAt ${retained.committedAt} for ${retained.sourceRevision}, but git records ${committedAt}.`,
    );
  }
  return {
    sourceRevision: retained.sourceRevision,
    committedAt: retained.committedAt,
  };
}

function isStringArray(value) {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function readHostManifest(path) {
  const absolute = resolve(process.cwd(), path);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`--host-manifest ${path}: ${error.message}`);
  }
  const problems = [];
  if (manifest?.schema !== HOST_MANIFEST_SCHEMA) {
    problems.push(`schema must be "${HOST_MANIFEST_SCHEMA}"`);
  }
  if (typeof manifest?.host !== "string" || manifest.host.length === 0) {
    problems.push("host must be a non-empty string");
  }
  if (typeof manifest?.version !== "string" || manifest.version.length === 0) {
    problems.push("version must be a non-empty string");
  }
  if (!isStringArray(manifest?.targets)) {
    problems.push("targets must be an array of strings");
  } else {
    const unknown = manifest.targets.filter(
      (target) => !Object.hasOwn(TARGET_CAPABILITY_MANIFESTS, target),
    );
    if (unknown.length > 0) {
      problems.push(`unknown targets: ${unknown.join(", ")}`);
    }
  }
  if (!isStringArray(manifest?.capabilities)) {
    problems.push("capabilities must be an array of strings");
  }
  if (problems.length > 0) {
    throw new Error(
      `--host-manifest ${path} is not a HostCapabilityManifest: ${problems.join("; ")}.`,
    );
  }
  return {
    schema: manifest.schema,
    host: manifest.host,
    version: manifest.version,
    targets: manifest.targets,
    capabilities: manifest.capabilities,
  };
}

let matrix;
try {
  matrix = generateFlowConformanceMatrix({
    provenance: check ? retainedProvenance() : headProvenance(),
    hosts: [
      DZUPAGENT_PIPELINE_HOST_MANIFEST,
      ...args["host-manifest"].map(readHostManifest),
    ],
  });
} catch (error) {
  fail(`Flow conformance matrix: ${error.message}`);
}

const markdown = renderFlowConformanceMatrixMarkdown(matrix);
const json = `${JSON.stringify(matrix, null, 2)}\n`;

if (check) {
  const stale = [
    [MARKDOWN_PATH, markdown],
    [JSON_PATH, json],
  ].filter(([path, expected]) =>
    !existsSync(path) || readFileSync(path, "utf8") !== expected
  );

  if (stale.length > 0) {
    fail(
      `Flow conformance artifacts are stale: ${stale
        .map(([path]) => path.slice(ROOT.length + 1))
        .join(", ")}. Run \`yarn docs:flow-conformance\` and commit the result.`,
    );
  }

  console.log(
    `Flow conformance artifacts are up to date (source revision ${matrix.provenance.sourceRevision}).`,
  );
  process.exit(0);
}

mkdirSync(dirname(MARKDOWN_PATH), { recursive: true });
writeFileSync(MARKDOWN_PATH, markdown);
writeFileSync(JSON_PATH, json);
console.log(
  `Generated ${MARKDOWN_PATH.slice(ROOT.length + 1)} and ${JSON_PATH.slice(ROOT.length + 1)} at ${matrix.provenance.sourceRevision}.`,
);
