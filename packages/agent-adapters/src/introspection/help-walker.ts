import { createHash } from "node:crypto";
import type { CommandSpec, ProbedCommandTree } from "@dzupagent/adapter-types/monitoring/installation";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  parseHelpFlags,
  parseHelpSubcommands,
  type ProbeResult,
  type SafeProbeCommandRunner,
} from "./probe-runner.js";

export type HelpWalkPartialReason =
  | "root-unreadable"
  | "denied-command"
  | "probe-failed"
  | "depth-limit"
  | "node-limit"
  | "output-limit"
  | "time-limit"
  | "cycle";

export interface HelpWalkFinding {
  reason: HelpWalkPartialReason;
  path: readonly string[];
}

/** Stable, separately persisted completeness evidence for a frozen V1 document. */
export interface HelpWalkCompleteness {
  complete: boolean;
  findings: readonly HelpWalkFinding[];
  observedNodes: number;
  probedNodes: number;
  capturedBytes: number;
  durationMs: number;
}

export interface HelpWalkLimits {
  maxDepth: number;
  maxNodes: number;
  maxOutputBytes: number;
  maxDurationMs: number;
  perProbeTimeoutMs: number;
}

export interface HelpWalkOptions {
  command: string;
  rootHelp: ProbeResult;
  runProbe: SafeProbeCommandRunner;
  limits?: Partial<HelpWalkLimits>;
  nowMs?: () => number;
}

export interface HelpWalkResult {
  tree: ProbedCommandTree;
  completeness: HelpWalkCompleteness;
}

export const DEFAULT_HELP_WALK_LIMITS: HelpWalkLimits = {
  maxDepth: 3,
  maxNodes: 32,
  maxOutputBytes: 256 * 1024,
  maxDurationMs: 15_000,
  perProbeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
};

/** Commands that may authenticate, mutate an installation, or spend credits. */
export const DENIED_HELP_COMMANDS: ReadonlySet<string> = new Set([
  "auth",
  "authenticate",
  "login",
  "logout",
  "install",
  "uninstall",
  "update",
  "upgrade",
  "remove",
  "delete",
  "exec",
  "run",
  "chat",
  "prompt",
  "query",
  "generate",
  "review",
  "resume",
  "fork",
]);

/**
 * Breadth-first `--help` traversal that invokes only observed, non-denied nodes.
 * Every early stop is represented in the stable completeness record.
 */
export async function walkHelpTree(options: HelpWalkOptions): Promise<HelpWalkResult> {
  const limits: HelpWalkLimits = { ...DEFAULT_HELP_WALK_LIMITS, ...options.limits };
  assertLimits(limits);
  const nowMs = options.nowMs ?? Date.now;
  const startedAt = nowMs();
  const findings: HelpWalkFinding[] = [];
  const findingKeys = new Set<string>();
  const rootPath = [options.command];
  const rootText = readableOutput(options.rootHelp);
  let capturedBytes = Buffer.byteLength(rootText);
  let probedNodes = 1;
  const root: CommandSpec = {
    path: rootPath,
    flags: parseHelpFlags(rootText),
  };
  const subcommands: CommandSpec[] = [];
  const queue: Array<{ path: string[]; depth: number }> = [];
  const knownPaths = new Set<string>();
  const expandedHelp = new Set<string>();

  const addFinding = (reason: HelpWalkPartialReason, path: readonly string[]): void => {
    const key = `${reason}:${path.join("\0")}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push({ reason, path: [...path] });
  };

  if (!rootText) addFinding("root-unreadable", rootPath);
  if (
    options.rootHelp.spawnFailed ||
    options.rootHelp.timedOut ||
    options.rootHelp.failure ||
    options.rootHelp.exitCode !== 0
  ) {
    addFinding("probe-failed", rootPath);
  }
  if (
    options.rootHelp.truncated ||
    options.rootHelp.failure === "output-limit" ||
    capturedBytes > limits.maxOutputBytes
  ) {
    addFinding("output-limit", rootPath);
  }
  expandedHelp.add(helpSignature(rootText));
  enqueueChildren(rootPath, 0, rootText);

  while (queue.length > 0) {
    const node = queue.shift()!;
    const leaf = node.path[node.path.length - 1]!;
    if (DENIED_HELP_COMMANDS.has(leaf.toLowerCase())) {
      addFinding("denied-command", node.path);
      continue;
    }
    if (node.depth > limits.maxDepth) {
      addFinding("depth-limit", node.path);
      continue;
    }
    if (probedNodes >= limits.maxNodes) {
      addFinding("node-limit", node.path);
      break;
    }
    const elapsed = Math.max(0, nowMs() - startedAt);
    if (elapsed >= limits.maxDurationMs) {
      addFinding("time-limit", node.path);
      break;
    }
    if (capturedBytes >= limits.maxOutputBytes) {
      addFinding("output-limit", node.path);
      break;
    }

    const remainingMs = Math.max(1, limits.maxDurationMs - elapsed);
    const result = await options.runProbe({
      command: options.command,
      args: [...node.path.slice(1), "--help"],
      timeoutMs: Math.min(limits.perProbeTimeoutMs, remainingMs),
    });
    probedNodes += 1;
    const helpText = readableOutput(result);
    capturedBytes += Buffer.byteLength(helpText);
    const command = subcommands.find((item) => pathKey(item.path) === pathKey(node.path));
    if (command) command.flags = parseHelpFlags(helpText);

    if (result.truncated || result.failure === "output-limit") {
      addFinding("output-limit", node.path);
    }
    if (result.spawnFailed || result.timedOut || result.failure || result.exitCode !== 0 || !helpText) {
      addFinding("probe-failed", node.path);
      continue;
    }
    if (capturedBytes > limits.maxOutputBytes) {
      addFinding("output-limit", node.path);
      break;
    }
    if (Math.max(0, nowMs() - startedAt) >= limits.maxDurationMs) {
      addFinding("time-limit", node.path);
      break;
    }

    const signature = helpSignature(helpText);
    if (expandedHelp.has(signature)) {
      addFinding("cycle", node.path);
      continue;
    }
    expandedHelp.add(signature);
    enqueueChildren(node.path, node.depth, helpText);
  }

  return {
    tree: { root, subcommands },
    completeness: {
      complete: findings.length === 0,
      findings,
      observedNodes: 1 + subcommands.length,
      probedNodes,
      capturedBytes: Math.min(capturedBytes, limits.maxOutputBytes),
      durationMs: Math.max(0, nowMs() - startedAt),
    },
  };

  function enqueueChildren(parent: readonly string[], parentDepth: number, helpText: string): void {
    for (const name of parseHelpSubcommands(helpText)) {
      const path = [...parent, name];
      const key = pathKey(path);
      if (knownPaths.has(key)) {
        addFinding("cycle", path);
        continue;
      }
      knownPaths.add(key);
      subcommands.push({ path });
      queue.push({ path, depth: parentDepth + 1 });
    }
  }
}

function readableOutput(result: ProbeResult): string {
  if (result.spawnFailed || result.timedOut) return "";
  return result.stdout || (result.exitCode === 0 ? result.stderr : "");
}

function helpSignature(helpText: string): string {
  const shape = JSON.stringify({
    flags: parseHelpFlags(helpText).sort(),
    subcommands: parseHelpSubcommands(helpText).sort(),
  });
  return createHash("sha256").update(shape).digest("hex");
}

function pathKey(path: readonly string[]): string {
  return path.join("\0");
}

function assertLimits(limits: HelpWalkLimits): void {
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0) {
    throw new Error("Help walk maxDepth must be a non-negative safe integer");
  }
  for (const [name, value] of Object.entries(limits)) {
    if (name === "maxDepth") continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Help walk limits must be positive safe integers");
    }
  }
}
