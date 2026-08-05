#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FlowDocumentV1, ToolResolver } from "@dzupagent/flow-ast";
import { parseDslToDocument } from "@dzupagent/flow-dsl";

import {
  createFlowCompiler,
  parseFlowCorpusManifest,
  qualifyFlowCorpusSources,
  renderFlowCorpusQualificationMarkdown,
} from "../src/index.js";

interface CliArgs {
  manifest?: string;
  format: "json" | "markdown";
  output?: string;
  help: boolean;
}

const PLACEHOLDER_TOOL_RESOLVER: ToolResolver = {
  resolve: (ref) => ({
    ref,
    kind: "skill",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    handle: { ref },
  }),
  listAvailable: () => [],
};

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n${usage()}\n`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.manifest === undefined) {
    process.stderr.write(`--manifest is required\n${usage()}\n`);
    return 1;
  }

  try {
    const manifestPath = path.resolve(args.manifest);
    const manifestRoot = path.dirname(manifestPath);
    const manifest = parseFlowCorpusManifest(
      JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    );
    const sources = await Promise.all(
      manifest.entries.map(async (entry) => {
        if (path.isAbsolute(entry.path)) {
          throw new Error(`manifest path must be relative: ${entry.path}`);
        }
        const sourcePath = path.resolve(manifestRoot, entry.path);
        const relative = path.relative(manifestRoot, sourcePath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error(`manifest path escapes its directory: ${entry.path}`);
        }
        return {
          ...entry,
          source: await readFile(sourcePath, "utf8"),
        };
      }),
    );
    const documents = new Map<string, FlowDocumentV1>();
    for (const source of sources) {
      const parsed = parseDslToDocument(source.source);
      if (!parsed.ok) continue;
      if (documents.has(parsed.document.id)) {
        throw new Error(
          `duplicate flow document id in corpus: ${parsed.document.id}`,
        );
      }
      documents.set(parsed.document.id, parsed.document);
    }
    const compiler = createFlowCompiler({
      toolResolver: PLACEHOLDER_TOOL_RESOLVER,
      personaResolver: { resolve: () => true },
      flowDocumentResolver: {
        resolve: (flowRef) => documents.get(flowRef) ?? null,
      },
      referencePolicy: "strict",
    });
    const report = await qualifyFlowCorpusSources(sources, compiler);
    const output =
      args.format === "markdown"
        ? renderFlowCorpusQualificationMarkdown(report)
        : `${JSON.stringify(report, null, 2)}\n`;
    if (args.output === undefined) {
      process.stdout.write(output);
    } else {
      await writeFile(path.resolve(args.output), output, "utf8");
    }
    return report.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    return 1;
  }
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { format: "json", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--manifest") {
      args.manifest = requiredNext(argv, ++index, "--manifest");
    } else if (arg === "--output") {
      args.output = requiredNext(argv, ++index, "--output");
    } else if (arg === "--format") {
      const value = requiredNext(argv, ++index, "--format");
      if (value !== "json" && value !== "markdown") {
        throw new Error("--format must be json or markdown");
      }
      args.format = value;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return args;
}

function requiredNext(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${option} requires a value`);
  return value;
}

function usage(): string {
  return [
    "Usage: dzupagent-qualify-flow-corpus --manifest <path>",
    "       [--format json|markdown] [--output <path>]",
    "",
    "Checks an explicit, hash-pinned DSL corpus with provider-free placeholder",
    "tool/persona resolvers and a corpus-backed subflow resolver. Exit 0 only",
    "when every hash matches, every source is strict-reference ready, and every",
    "compile-example compiles.",
  ].join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().then((code) => {
  process.exitCode = code;
});
