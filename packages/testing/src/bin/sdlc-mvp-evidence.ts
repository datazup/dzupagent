#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createLivePostgresClient,
  createLiveRedisClient,
  runSdlcMvpEvidenceReport,
  type HostValidationCommandOutput,
  type SdlcMvpEvidenceReportOptions,
} from "../sdlc-validation.js";
import type {
  PostgresClientLike,
  RedisClientLike,
} from "@dzupagent/agent/pipeline";

interface SdlcMvpEvidenceCliDeps {
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  readFile?: (path: string) => string;
  redisClientFactory?: (url: string) => Promise<RedisClientLike>;
  postgresClientFactory?: (url: string) => Promise<PostgresClientLike>;
}

interface ParsedArgs {
  commandOutputJsonPath?: string;
  packetJsonPath?: string;
  help: boolean;
}

interface PacketEvidence {
  ref: string;
}

const HELP = `Usage: dzupagent-sdlc-mvp-evidence [options]

Options:
  --command-output-json <path>  JSON array of host validation command outputs.
  --packet-json <path>          JSON array of packet references, each with ref.
  --help                        Show this help text.
`;

export async function runSdlcMvpEvidenceCli(
  args: readonly string[] = process.argv.slice(2),
  deps: SdlcMvpEvidenceCliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((line) => console.log(line));
  const stderr = deps.stderr ?? ((line) => console.error(line));
  const readFile = deps.readFile ?? ((path) => readFileSync(path, "utf8"));

  try {
    const parsedArgs = parseArgs(args);
    if (parsedArgs.help) {
      stdout(HELP.trimEnd());
      return 0;
    }

    const options: SdlcMvpEvidenceReportOptions = {
      env: deps.env ?? process.env,
      redisClientFactory: deps.redisClientFactory ?? createLiveRedisClient,
      postgresClientFactory:
        deps.postgresClientFactory ?? createLivePostgresClient,
    };
    if (parsedArgs.commandOutputJsonPath !== undefined) {
      options.commandOutputs = readCommandOutputs(
        readFile(parsedArgs.commandOutputJsonPath),
      );
    }
    if (parsedArgs.packetJsonPath !== undefined) {
      options.packetItems = readPacketEvidence(readFile(parsedArgs.packetJsonPath));
    }

    const report = await runSdlcMvpEvidenceReport(options);
    stdout(JSON.stringify(report, null, 2));
    return report.parseOk && report.compileOk && report.runtimeReady ? 0 : 1;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--command-output-json") {
      parsed.commandOutputJsonPath = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--packet-json") {
      parsed.packetJsonPath = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function readCommandOutputs(source: string): HostValidationCommandOutput[] {
  const value = JSON.parse(source) as unknown;
  if (!Array.isArray(value)) {
    throw new Error("--command-output-json must contain a JSON array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`command output at index ${index} must be an object`);
    }
    const id = item["id"];
    const command = item["command"];
    const exitCode = item["exitCode"];
    const stdout = item["stdout"];
    const stderr = item["stderr"];
    const durationMs = item["durationMs"];
    if (
      typeof id !== "string" ||
      typeof command !== "string" ||
      typeof exitCode !== "number" ||
      typeof stdout !== "string" ||
      typeof stderr !== "string"
    ) {
      throw new Error(
        `command output at index ${index} must include id, command, exitCode, stdout, and stderr`,
      );
    }
    const output: HostValidationCommandOutput = {
      id,
      command,
      exitCode,
      stdout,
      stderr,
    };
    if (durationMs !== undefined) {
      if (typeof durationMs !== "number") {
        throw new Error(`command output at index ${index} has invalid durationMs`);
      }
      output.durationMs = durationMs;
    }
    return output;
  });
}

function readPacketEvidence(source: string): PacketEvidence[] {
  const value = JSON.parse(source) as unknown;
  if (!Array.isArray(value)) {
    throw new Error("--packet-json must contain a JSON array");
  }
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item["ref"] !== "string") {
      throw new Error(`packet evidence at index ${index} must include ref`);
    }
    return { ref: item["ref"] };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runSdlcMvpEvidenceCli();
}
