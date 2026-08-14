#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateAiExecutionEventSequence,
  validateAiExecutionReceipt,
  validateAiExecutionRequest,
  validateAiExecutionTranscript,
  validateAiPublicTargetDescriptor,
} from "../dist/ai-execution.js";
import { validateAiExecutionReceiptCustody } from "../dist/ai-execution-node.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const legacyFixturePath = join(root, "fixtures", "ai-execution-conformance-v1.json");
const fixturePath = join(root, "fixtures", "ai-execution-conformance-v2.json");
const legacyCorpus = JSON.parse(await readFile(legacyFixturePath, "utf8"));
const corpus = JSON.parse(await readFile(fixturePath, "utf8"));

if (legacyCorpus.schema !== "dzupagent.aiExecutionConformanceCorpus/v1"
  || !Array.isArray(legacyCorpus.cases)
  || legacyCorpus.cases.length === 0
  || corpus.schema !== "dzupagent.aiExecutionConformanceCorpus/v2"
  || !Array.isArray(corpus.cases)
  || corpus.cases.length === 0
  || !Array.isArray(corpus.negativeCases)
  || corpus.negativeCases.length === 0) {
  throw new Error("AI execution conformance corpus schema or cases are invalid");
}

function validateCase(candidate) {
  const roundTripped = JSON.parse(JSON.stringify(candidate));
  return [
    validateAiExecutionRequest(roundTripped.request),
    validateAiPublicTargetDescriptor(roundTripped.publicTarget),
    validateAiExecutionEventSequence(roundTripped.events),
    validateAiExecutionReceipt(roundTripped.receipt),
    validateAiExecutionReceiptCustody(roundTripped.receipt),
    validateAiExecutionTranscript(roundTripped.receipt, roundTripped.events),
  ];
}

for (const candidate of [...legacyCorpus.cases, ...corpus.cases]) {
  const validations = validateCase(candidate);
  const actual = validations.every(({ valid }) => valid);
  if (actual !== candidate.expected?.valid) {
    const codes = validations.flatMap(({ diagnostics }) => diagnostics.map(({ code }) => code));
    throw new Error(`AI execution conformance case ${String(candidate.id)} failed: ${codes.join(", ")}`);
  }
}

const positive = corpus.cases[0];
for (const negative of corpus.negativeCases) {
  const candidate = JSON.parse(JSON.stringify(positive));
  let target = candidate;
  for (const segment of negative.path.slice(0, -1)) {
    target = target[segment];
  }
  target[negative.path.at(-1)] = negative.value;
  const validations = validateCase(candidate);
  const codes = validations.flatMap(({ diagnostics }) => diagnostics.map(({ code }) => code));
  if (validations.every(({ valid }) => valid) || !codes.includes(negative.expectedCode)) {
    throw new Error(
      `AI execution negative case ${String(negative.id)} failed: ${codes.join(", ")}`,
    );
  }
}

console.log(
  `AI execution conformance fixtures passed (${legacyCorpus.cases.length} v1; `
    + `${corpus.cases.length} v2; ${corpus.negativeCases.length} negative).`,
);
