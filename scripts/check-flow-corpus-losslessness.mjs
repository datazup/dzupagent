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
 * The corpus lives in the SIBLING workspace-docs repo, not in dzupagent, so
 * this gate is conditional by necessity: CI checks out dzupagent alone and
 * must not fail for a corpus it was never given. When the corpus is absent
 * the script SKIPS (exit 0). To keep that skip from becoming a permanently
 * green no-op, `--require-corpus` turns a missing corpus into a failure — use
 * it anywhere the corpus is known to be present.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const MODULE_PATH = join(ROOT, "packages", "flow-compiler", "dist", "index.js");
const DSL_MODULE_PATH = join(ROOT, "packages", "flow-dsl", "dist", "index.js");
const MANIFEST_PATH = resolve(
  ROOT,
  "..",
  "workspace-docs",
  "repos",
  "dzupagent",
  "docs",
  "flow-dsl",
  "examples",
  "qualification.manifest.json",
);

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

if (!existsSync(MANIFEST_PATH)) {
  const detail = `corpus manifest not found at ${MANIFEST_PATH}`;
  if (requireCorpus) {
    console.error(`Flow corpus losslessness gate: ${detail}`);
    console.error(
      "--require-corpus was passed, so a missing corpus is a failure.",
    );
    process.exit(1);
  }
  console.log(
    `Flow corpus losslessness gate: SKIPPED (${detail}). The corpus lives in the sibling workspace-docs repo; pass --require-corpus to make this a failure.`,
  );
  process.exit(0);
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

const manifestRoot = dirname(MANIFEST_PATH);
const manifest = parseFlowCorpusManifest(
  JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
);

const sources = manifest.entries.map((entry) => {
  const sourcePath = resolve(manifestRoot, entry.path);
  return { ...entry, source: readFileSync(sourcePath, "utf8") };
});

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
