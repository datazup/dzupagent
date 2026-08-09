import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpath } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createNodeProbeRunner,
  createNodeProbeRunnerForTesting,
  type ProbeCapture,
  type ResolvedProbeExecutable,
} from "../node-probe-runner.js";
import { walkHelpTree } from "../help-walker.js";
import type { ProbeCommand, ProbeCommandRunner, ProbeResult } from "../probe-runner.js";
import { ClaudeInstallationInspector } from "../claude-inspector.js";
import { CodexInstallationInspector } from "../codex-inspector.js";
import { GeminiInstallationInspector } from "../gemini-inspector.js";
import { QwenInstallationInspector } from "../qwen-inspector.js";
import type { AdapterInstallationInspector, InspectorContext } from "../adapter-installation-inspector.js";
import { ok, recordingRunner } from "./fixtures/probe-fixtures.js";

const MANAGED_HOME = "/managed/probe-home";
const HELP = `Usage: cli [command]\n\nCommands:\n  mcp       Safe metadata\n  auth      Authenticate\n  install   Install extension\n  update    Update CLI\n  remove    Remove extension\n  login     Log in\n  exec      Run a metered task\n\nOptions:\n  --version\n`;
let nodeIdentity: ResolvedProbeExecutable;

beforeAll(async () => {
  nodeIdentity = { name: "fixture-node", path: process.execPath, realPath: await realpath(process.execPath) };
});

function nodeRunner(overrides: Parameters<typeof createNodeProbeRunnerForTesting>[0] = {
  executables: [],
  managedHome: MANAGED_HOME,
  cwd: process.cwd(),
}) {
  return createNodeProbeRunnerForTesting({
    executables: [nodeIdentity],
    managedHome: MANAGED_HOME,
    cwd: process.cwd(),
    sourceEnv: {
      PATH: process.env.PATH,
      LANG: "C",
      OPENAI_API_KEY: "sk-parent-secret-value",
    },
    ...overrides,
  });
}

describe("framework-owned Node probe runner", () => {
  it("rejects arbitrary callbacks at the public inspector boundary", () => {
    const bypass: ProbeCommandRunner = async () => ok("attacker-controlled");

    // @ts-expect-error An unbranded callback cannot satisfy normal public construction.
    const rejectedContext: InspectorContext = {
      runProbe: bypass,
      managedHome: MANAGED_HOME,
      now: () => "2026-08-09T00:00:00.000Z",
    };

    expect(
      () => new ClaudeInstallationInspector(rejectedContext as unknown as InspectorContext),
    ).toThrow("framework-owned safe probe runner");
  });

  it("does not expose fixture ports or permit limits above mandatory ceilings", async () => {
    const compilePublicOptions = (): void => {
      createNodeProbeRunner({
        executables: [nodeIdentity],
        managedHome: MANAGED_HOME,
        cwd: process.cwd(),
        // @ts-expect-error Process ports are internal test-only capabilities.
        ports: { spawn: nodeSpawn },
      });
    };
    void compilePublicOptions;

    const runner = createNodeProbeRunner({
      executables: [nodeIdentity],
      managedHome: MANAGED_HOME,
      cwd: process.cwd(),
      limits: { maxOutputBytes: 128 * 1024 + 1 },
    });

    expect(
      () => new ClaudeInstallationInspector({
        runProbe: runner,
        managedHome: MANAGED_HOME,
        now: () => "2026-08-09T00:00:00.000Z",
      }),
    ).not.toThrow();

    await expect(runner({ command: "fixture-node", args: ["--version"] })).resolves.toMatchObject({
      failure: "invalid-policy",
      stderr: "[probe:invalid-policy]",
    });
  });

  it("uses the resolved identity, explicit cwd, shell:false, no stdin/TTY, and allowlisted managed env", async () => {
    let observedCommand = "";
    let observedOptions: SpawnOptions | undefined;
    const runner = nodeRunner({
      executables: [nodeIdentity],
      managedHome: MANAGED_HOME,
      cwd: process.cwd(),
      sourceEnv: { PATH: process.env.PATH, OPENAI_API_KEY: "sk-parent-secret-value" },
      ports: {
        spawn(command, args, options) {
          observedCommand = command;
          observedOptions = options;
          return nodeSpawn(command, [...args], options);
        },
      },
    });

    const result = await runner({ command: "fixture-node", args: ["--version"] });

    expect(result.exitCode).toBe(0);
    expect(observedCommand).toBe(nodeIdentity.realPath);
    expect(observedOptions).toMatchObject({
      cwd: process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const env = observedOptions?.env as Record<string, string>;
    expect(env.HOME).toBe(MANAGED_HOME);
    expect(env.XDG_CONFIG_HOME).toBe(`${MANAGED_HOME}/.config`);
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("classifies a missing binary without exposing a host error", async () => {
    const runner = nodeRunner({
      executables: [{ name: "missing", path: "/missing/bin", realPath: "/missing/bin" }],
      managedHome: MANAGED_HOME,
      cwd: process.cwd(),
      ports: {
        realpath: async () => {
          throw Object.assign(new Error("/secret/host/path"), { code: "ENOENT" });
        },
      },
    });

    const result = await runner({ command: "missing", args: ["--version"] });

    expect(result).toMatchObject({
      failure: "missing-binary",
      spawnFailed: true,
      stderr: "[probe:missing-binary]",
    });
    expect(JSON.stringify(result)).not.toContain("/secret/host/path");
  });

  it("rejects an executable whose canonical identity changed", async () => {
    const runner = nodeRunner({
      executables: [{ name: "cli", path: "/trusted/cli", realPath: "/trusted/cli" }],
      managedHome: MANAGED_HOME,
      cwd: process.cwd(),
      ports: { realpath: async () => "/replaced/cli" },
    });

    await expect(runner({ command: "cli", args: ["--help"] })).resolves.toMatchObject({
      failure: "executable-identity-mismatch",
      stderr: "[probe:executable-identity-mismatch]",
    });
  });

  it("bounds output, redacts captures, and never leaks planted secrets", async () => {
    const captures: ProbeCapture[] = [];
    const runner = nodeRunner({
      executables: [nodeIdentity],
      managedHome: MANAGED_HOME,
      cwd: process.cwd(),
      limits: { maxOutputBytes: 256 },
      ports: { capture: (capture) => captures.push(capture) },
    });
    const secret = "sk-ThisMustNeverEscape12345";

    const secretResult = await runner({
      command: "fixture-node",
      args: ["-e", `console.log('token=${secret}'); console.error('Bearer ${secret}')`],
    });
    const truncatedResult = await runner({
      command: "fixture-node",
      args: ["-e", "process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000)"],
    });

    expect(secretResult.stdout).toContain("token=[REDACTED]");
    expect(secretResult.stderr).toContain("Bearer [REDACTED]");
    expect(JSON.stringify({ secretResult, captures })).not.toContain(secret);
    expect(truncatedResult).toMatchObject({ failure: "output-limit", truncated: true });
    expect(Buffer.byteLength(truncatedResult.stdout)).toBeLessThanOrEqual(256);
  });

  it("strictly rejects invalid UTF-8 without leaking replacement text or raw bytes", async () => {
    const child = fakeChild();
    const runner = nodeRunner({
      executables: [{ name: "cli", path: "/trusted/cli", realPath: "/trusted/cli" }],
      managedHome: MANAGED_HOME,
      cwd: process.cwd(),
      ports: {
        realpath: async (path) => path,
        statDirectory: async () => true,
        spawn: () => {
          queueMicrotask(() => {
            child.stdout?.emit("data", Buffer.from([0xc3, 0x28]));
            child.emit("close", 0, null);
          });
          return child;
        },
      },
    });

    const result = await runner({ command: "cli", args: ["--help"] });

    expect(result).toMatchObject({
      failure: "invalid-encoding",
      stdout: "",
      stderr: "[probe:invalid-encoding]",
    });
    expect(JSON.stringify(result)).not.toContain("�");
  });

  it("times out and escalates from process-tree TERM to KILL", async () => {
    const child = fakeChild();
    const signals: NodeJS.Signals[] = [];
    const runner = nodeRunner({
      executables: [{ name: "cli", path: "/trusted/cli", realPath: "/trusted/cli" }],
      managedHome: MANAGED_HOME,
      cwd: process.cwd(),
      limits: { maxDurationMs: 40, killGraceMs: 5 },
      ports: {
        realpath: async (path) => path,
        statDirectory: async () => true,
        spawn: () => child,
        killProcessTree: (_child, signal) => signals.push(signal),
      },
    });

    const result = await runner({ command: "cli", args: ["--help"], timeoutMs: 5 });

    expect(result).toMatchObject({ failure: "timeout", timedOut: true });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("bounded help walker", () => {
  it("records root help failures and truncation as partial completeness", async () => {
    const unused = recordingRunner({});
    const failed = await walkHelpTree({
      command: "cli",
      rootHelp: { ...ok("Options:\n  --help\n"), exitCode: 2, failure: "exit-nonzero" },
      runProbe: unused.run,
    });
    const truncated = await walkHelpTree({
      command: "cli",
      rootHelp: { ...ok("Commands:\n  mcp    MCP\n"), truncated: true, failure: "output-limit" },
      runProbe: unused.run,
    });

    expect(failed.completeness).toMatchObject({ complete: false });
    expect(failed.completeness.findings).toContainEqual({ reason: "probe-failed", path: ["cli"] });
    expect(truncated.completeness).toMatchObject({ complete: false });
    expect(truncated.completeness.findings).toContainEqual({ reason: "output-limit", path: ["cli"] });
  });

  it("walks breadth-first and never invokes auth, mutation, login, or metered commands", async () => {
    const runner = recordingRunner({
      "cli mcp --help": ok("Commands:\n  list    List servers\n  auth    Authenticate\n"),
      "cli mcp list --help": ok("Options:\n  --json\n"),
    });

    const result = await walkHelpTree({ command: "cli", rootHelp: ok(HELP), runProbe: runner.run });
    const calls = runner.calls.map(renderCall);

    expect(calls).toEqual(["cli mcp --help", "cli mcp list --help"]);
    expect(calls.join(" ")).not.toMatch(/\b(auth|install|update|remove|login|exec)\b/);
    expect(result.tree.subcommands.map((node) => node.path.join(" "))).toEqual([
      "cli mcp",
      "cli auth",
      "cli install",
      "cli update",
      "cli remove",
      "cli login",
      "cli exec",
      "cli mcp list",
      "cli mcp auth",
    ]);
    expect(result.completeness.findings.filter((item) => item.reason === "denied-command")).toHaveLength(7);
  });

  it("records cycles and output/node bounds as partial rather than guessing completeness", async () => {
    const cycleRunner = recordingRunner({ "cli mcp --help": ok(HELP) });
    const cycle = await walkHelpTree({ command: "cli", rootHelp: ok(HELP), runProbe: cycleRunner.run });
    const bounded = await walkHelpTree({
      command: "cli",
      rootHelp: ok(HELP),
      runProbe: cycleRunner.run,
      limits: { maxOutputBytes: 16, maxNodes: 1 },
    });

    expect(cycle.completeness.complete).toBe(false);
    expect(cycle.completeness.findings).toContainEqual({ reason: "cycle", path: ["cli", "mcp"] });
    expect(bounded.completeness.findings.some((item) => item.reason === "output-limit")).toBe(true);
    expect(cycleRunner.calls.length).toBe(1);
  });

  it("enforces depth, node, and total-time limits with stable findings", async () => {
    const responses = recordingRunner({
      "cli mcp --help": ok("Commands:\n  list    List servers\n"),
      "cli mcp list --help": ok("Commands:\n  details    Show details\n"),
    });
    const depth = await walkHelpTree({
      command: "cli",
      rootHelp: ok("Commands:\n  mcp    MCP\n"),
      runProbe: responses.run,
      limits: { maxDepth: 1 },
    });
    const node = await walkHelpTree({
      command: "cli",
      rootHelp: ok("Commands:\n  mcp    MCP\n  plugin    Plugins\n"),
      runProbe: responses.run,
      limits: { maxNodes: 1 },
    });
    let tick = 0;
    const time = await walkHelpTree({
      command: "cli",
      rootHelp: ok("Commands:\n  mcp    MCP\n"),
      runProbe: responses.run,
      limits: { maxDurationMs: 1 },
      nowMs: () => tick++,
    });

    expect(depth.completeness.findings).toContainEqual({
      reason: "depth-limit",
      path: ["cli", "mcp", "list"],
    });
    expect(node.completeness.findings).toContainEqual({ reason: "node-limit", path: ["cli", "mcp"] });
    expect(time.completeness.findings).toContainEqual({ reason: "time-limit", path: ["cli", "mcp"] });
  });

  it("routes all four inspectors through the walker and emits partial-completeness evidence", async () => {
    const providers = [
      ["claude", (context: InspectorContext) => new ClaudeInstallationInspector(context)],
      ["codex", (context: InspectorContext) => new CodexInstallationInspector(context)],
      ["gemini", (context: InspectorContext) => new GeminiInstallationInspector(context)],
      ["qwen", (context: InspectorContext) => new QwenInstallationInspector(context)],
    ] as const;

    for (const [provider, createInspector] of providers) {
      const runner = recordingRunner({
        [`${provider} --version`]: ok(`${provider} 1.2.3`),
        [`${provider} --help`]: ok(HELP),
        [`${provider} mcp --help`]: ok("Options:\n  --json\n"),
      });
      const completeness: Parameters<NonNullable<InspectorContext["onHelpWalkComplete"]>>[0][] = [];
      const inspector: AdapterInstallationInspector = createInspector({
        runProbe: runner.run,
        managedHome: MANAGED_HOME,
        now: () => "2026-08-09T00:00:00.000Z",
        onHelpWalkComplete: (record) => completeness.push(record),
      });

      const document = await inspector.inspect({
        installationId: `inst-${provider}`,
        coordinates: { providerId: provider, backend: "cli" },
        hostBindingId: "host-1",
        managed: true,
      });

      expect(runner.calls.map(renderCall)).toContain(`${provider} mcp --help`);
      expect(completeness).toHaveLength(1);
      expect(completeness[0]?.complete).toBe(false);
      expect(document.binary.executable).toBe(true);
    }
  });
});

function renderCall(call: ProbeCommand): string {
  return [call.command, ...call.args].join(" ");
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  return child;
}
