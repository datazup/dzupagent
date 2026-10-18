#!/usr/bin/env node

/**
 * Round-trip fidelity ratchet for the hash-pinned flow DSL corpus.
 *
 * The corpus reached 26/26 lossless (dzupagent c48f4c70/7edaa088), and
 * `qualifyFlowCorpusSources` grew an opt-in `minLossless` floor (c4106906).
 * Shipping that floor is not the same as enforcing it: until something
 * actually passes it, a fidelity regression is silent. This script is the
 * caller that arms it.
 *
 * The corpus is read from this repository's docs/flow-dsl/examples/ copy and
 * falls back to the sibling workspace-docs copy when the in-repository one is
 * absent. When both copies exist their manifests must be byte-identical, so
 * the two can never silently drift apart. Every entry is digest-checked
 * against the manifest before dist is imported.
 *
 * When neither copy is present the script SKIPS (exit 0). To keep that skip
 * from becoming a permanently green no-op, `--require-corpus` turns a missing
 * corpus into a failure — use it anywhere the corpus is known to be present.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

const MANIFEST_SEGMENTS = [
  "docs",
  "flow-dsl",
  "examples",
  "qualification.manifest.json",
];

/** Error code for "no corpus manifest in either location"; main() maps it to skip / --require-corpus failure. */
export const CORPUS_MANIFEST_NOT_FOUND = "CORPUS_MANIFEST_NOT_FOUND";
/** Error code for byte drift between the in-repository and workspace-docs manifests. */
export const CORPUS_MANIFEST_DRIFT = "CORPUS_MANIFEST_DRIFT";
/** Error code for an entry whose bytes do not match the manifest's sha256. */
export const CORPUS_ENTRY_DIGEST_MISMATCH = "CORPUS_ENTRY_DIGEST_MISMATCH";

function corpusError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Resolves the corpus manifest. The in-repository copy wins; the
 * workspace-docs sibling is the fallback. When both exist they must be
 * byte-identical, otherwise this throws naming both paths.
 */
export function resolveCorpusManifestPath(root, workspaceRoot) {
  const inRepo = resolve(root, ...MANIFEST_SEGMENTS);
  const sibling = resolve(
    workspaceRoot,
    "workspace-docs",
    "repos",
    "dzupagent",
    ...MANIFEST_SEGMENTS,
  );
  const hasInRepo = existsSync(inRepo);
  const hasSibling = existsSync(sibling);

  if (hasInRepo && hasSibling && inRepo !== sibling) {
    if (!readFileSync(inRepo).equals(readFileSync(sibling))) {
      throw corpusError(
        CORPUS_MANIFEST_DRIFT,
        `corpus manifests drifted: ${inRepo} and ${sibling} are not byte-identical`,
      );
    }
  }
  if (hasInRepo) return inRepo;
  if (hasSibling) return sibling;
  throw corpusError(
    CORPUS_MANIFEST_NOT_FOUND,
    `corpus manifest not found at ${inRepo} or ${sibling}`,
  );
}

/**
 * Reads the manifest and every entry relative to the manifest directory,
 * rejecting any entry whose sha256 differs from the manifest's pin.
 *
 * @returns {Array<object>} manifest entries, each with its `source` text
 */
export function loadCorpusSources(manifestPath) {
  const manifestRoot = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest || !Array.isArray(manifest.entries)) {
    throw new Error(`corpus manifest ${manifestPath} has no entries array`);
  }
  return manifest.entries.map((entry) => {
    const sourcePath = resolve(manifestRoot, entry.path);
    const bytes = readFileSync(sourcePath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256) {
      throw corpusError(
        CORPUS_ENTRY_DIGEST_MISMATCH,
        `corpus entry ${entry.path} (${sourcePath}) sha256 ${actual} does not match manifest sha256 ${entry.sha256}`,
      );
    }
    return { ...entry, source: bytes.toString("utf8") };
  });
}

export function resolveAuditWorkspaceRoot(repoRoot, explicitRoot = process.env.DATAZUP_AUDIT_WORKSPACE_ROOT) {
  if (explicitRoot) return resolve(explicitRoot);
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repoRoot, encoding: "utf8",
  });
  if (common.status === 0 && common.stdout.trim()) {
    const canonicalWorkspace = dirname(dirname(common.stdout.trim()));
    if (existsSync(join(canonicalWorkspace, "workspace-docs"))) return canonicalWorkspace;
  }
  return resolve(repoRoot, "..");
}
const MODULE_PATH = join(ROOT, "packages", "flow-compiler", "dist", "index.js");
const DSL_MODULE_PATH = join(ROOT, "packages", "flow-dsl", "dist", "index.js");

/**
 * The floor. Raise this — never lower it — as fidelity improves; that
 * one-way movement is what makes it a ratchet rather than a thermometer.
 */
const MIN_LOSSLESS = 26;

/**
 * Decides the gate verdict from a measured report. Extracted so the ratchet
 * arithmetic is unit-testable without building dist or checking out the
 * sibling corpus repo.
 *
 * @returns {{ok: boolean, code: string, message: string, details: string[]}}
 */
export function evaluateCorpusLosslessness(report, minLossless) {
  const { lossless, lossy, notReparsable, unparsableSource, total } =
    report.roundTrip;

  if (report.roundTrip.belowMinLossless) {
    return {
      ok: false,
      code: "ROUND_TRIP_REGRESSED",
      message: `Flow corpus round-trip fidelity REGRESSED: ${lossless}/${total} lossless, floor is ${minLossless}.`,
      details: [
        `lossy=${lossy} not-reparsable=${notReparsable} unparsable-source=${unparsableSource}`,
        ...report.items
          .filter((item) => item.roundTripStatus !== "lossless")
          .map(
            (item) =>
              `${item.path}: ${item.roundTripStatus}${
                item.roundTripLossPaths.length > 0
                  ? ` (lost: ${item.roundTripLossPaths.join(", ")})`
                  : ""
              }`,
          ),
      ],
    };
  }

  if (!report.passed) {
    // Admission can fail for reasons unrelated to fidelity (hash drift, a
    // compile-example that stopped compiling). Surface those rather than
    // reporting a green ratchet on a red corpus.
    return {
      ok: false,
      code: "QUALIFICATION_FAILED",
      message: "Flow corpus qualification failed for a non-round-trip reason.",
      details: [JSON.stringify(report.summary)],
    };
  }

  return {
    ok: true,
    code: "OK",
    message: `Flow corpus round-trip fidelity holds: ${lossless}/${total} lossless (floor ${minLossless}).`,
    details: [],
  };
}

async function main() {
const requireCorpus = process.argv.includes("--require-corpus");

let manifestPath;
try {
  manifestPath = resolveCorpusManifestPath(ROOT, resolveAuditWorkspaceRoot(ROOT));
} catch (error) {
  if (error?.code !== CORPUS_MANIFEST_NOT_FOUND) {
    console.error(`Flow corpus losslessness gate: ${error.message}`);
    process.exit(1);
  }
  const detail = error.message;
  if (requireCorpus) {
    console.error(`Flow corpus losslessness gate: ${detail}`);
    console.error(
      "--require-corpus was passed, so a missing corpus is a failure.",
    );
    process.exit(1);
  }
  console.log(
    `Flow corpus losslessness gate: SKIPPED (${detail}). Pass --require-corpus to make this a failure.`,
  );
  process.exit(0);
}

let sources;
try {
  sources = loadCorpusSources(manifestPath);
} catch (error) {
  console.error(`Flow corpus losslessness gate: ${error.message}`);
  process.exit(1);
}

for (const [label, path] of [
  ["flow-compiler", MODULE_PATH],
  ["flow-dsl", DSL_MODULE_PATH],
]) {
  if (!existsSync(path)) {
    console.error(
      `${label} dist is missing. Run \`yarn build --filter=@dzupagent/flow-compiler\` before running this gate; a stale or absent dist reports pre-fix round-trip numbers.`,
    );
    process.exit(1);
  }
}

const {
  createFlowCompiler,
  parseFlowCorpusManifest,
  qualifyFlowCorpusSources,
} = await import(pathToFileURL(MODULE_PATH).href);
const { parseDslToDocument } = await import(
  pathToFileURL(DSL_MODULE_PATH).href
);

// Schema validation stays with the compiler's own manifest parser; the
// digest-checked sources above are what gets qualified.
parseFlowCorpusManifest(JSON.parse(readFileSync(manifestPath, "utf8")));

// Mirrors bin/qualify-corpus.ts: provider-free placeholder resolvers keep this
// an authoring-fidelity check, never a runtime or host qualification.
const documents = new Map();
for (const source of sources) {
  const parsed = parseDslToDocument(source.source);
  if (!parsed.ok) continue;
  documents.set(parsed.document.id, parsed.document);
}

const compiler = createFlowCompiler({
  toolResolver: {
    resolve: (ref) => ({
      ref,
      kind: "skill",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handle: { ref },
    }),
    listAvailable: () => [],
  },
  personaResolver: { resolve: () => true },
  flowDocumentResolver: { resolve: (flowRef) => documents.get(flowRef) ?? null },
  referencePolicy: "strict",
});

const report = await qualifyFlowCorpusSources(sources, compiler, {
  minLossless: MIN_LOSSLESS,
});

const verdict = evaluateCorpusLosslessness(report, MIN_LOSSLESS);

if (!verdict.ok) {
  console.error(verdict.message);
  for (const detail of verdict.details) console.error(`  ${detail}`);
  process.exit(1);
}

console.log(verdict.message);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
