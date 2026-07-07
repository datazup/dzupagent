#!/usr/bin/env node

import process from "node:process";

import {
  runSdlcMvpEvidenceReport,
  shapeSdlcMvpEvidenceCommandOutputs,
} from "../sdlc-mvp-evidence.js";

function readArgValue(args: readonly string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function printHelp(): void {
  process.stdout.write(`Usage: dzupagent-sdlc-mvp-evidence --command-output-json <path> [--packet-json <path>]

Builds a JSON SDLC MVP evidence report from host validation command outputs.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const commandOutputJsonPath = readArgValue(args, "--command-output-json");
  if (!commandOutputJsonPath) {
    throw new Error("--command-output-json is required");
  }

  const shaped = await shapeSdlcMvpEvidenceCommandOutputs({
    commandOutputJsonPath,
    packetJsonPath: readArgValue(args, "--packet-json"),
  });
  const report = await runSdlcMvpEvidenceReport({
    ...shaped,
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
