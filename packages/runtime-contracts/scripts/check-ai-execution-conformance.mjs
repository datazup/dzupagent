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
const fixturePath = join(root, "fixtures", "ai-execution-conformance-v1.json");
const corpus = JSON.parse(await readFile(fixturePath, "utf8"));

if (corpus.schema !== "dzupagent.aiExecutionConformanceCorpus/v1"
  || !Array.isArray(corpus.cases)
  || corpus.cases.length === 0) {
  throw new Error("AI execution conformance corpus schema or cases are invalid");
}

for (const candidate of corpus.cases) {
  const roundTripped = JSON.parse(JSON.stringify(candidate));
  const validations = [
    validateAiExecutionRequest(roundTripped.request),
    validateAiPublicTargetDescriptor(roundTripped.publicTarget),
    validateAiExecutionEventSequence(roundTripped.events),
    validateAiExecutionReceipt(roundTripped.receipt),
    validateAiExecutionReceiptCustody(roundTripped.receipt),
    validateAiExecutionTranscript(roundTripped.receipt, roundTripped.events),
  ];
  const actual = validations.every(({ valid }) => valid);
  if (actual !== roundTripped.expected?.valid) {
    const codes = validations.flatMap(({ diagnostics }) => diagnostics.map(({ code }) => code));
    throw new Error(`AI execution conformance case ${String(roundTripped.id)} failed: ${codes.join(", ")}`);
  }
}

console.log(`AI execution conformance fixture passed (${corpus.cases.length} case).`);
