#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
const check = process.argv.includes("--check");

if (!existsSync(MODULE_PATH)) {
  console.error(
    "flow-compiler dist is missing. Run `yarn build --filter=@dzupagent/flow-compiler` before generating the matrix.",
  );
  process.exit(1);
}

const {
  generateFlowConformanceMatrix,
  renderFlowConformanceMatrixMarkdown,
} = await import(pathToFileURL(MODULE_PATH).href);

const matrix = generateFlowConformanceMatrix();
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
    console.error(
      `Flow conformance artifacts are stale: ${stale
        .map(([path]) => path.slice(ROOT.length + 1))
        .join(", ")}`,
    );
    process.exit(1);
  }

  console.log("Flow conformance artifacts are up to date.");
  process.exit(0);
}

mkdirSync(dirname(MARKDOWN_PATH), { recursive: true });
writeFileSync(MARKDOWN_PATH, markdown);
writeFileSync(JSON_PATH, json);
console.log(
  `Generated ${MARKDOWN_PATH.slice(ROOT.length + 1)} and ${JSON_PATH.slice(ROOT.length + 1)}.`,
);
