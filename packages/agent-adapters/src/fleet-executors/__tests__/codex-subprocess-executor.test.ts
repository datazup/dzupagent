import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CodexSubprocessExecutor } from "../codex-subprocess-executor.js";
import { parseCodexLine } from "../worker-event-parser.js";

const fakeBin = `
import { writeSync } from "node:fs";

const events = [
  JSON.stringify({ type: 'turn_started', turn_id: 's1' }),
  JSON.stringify({ type: 'message', role: 'assistant', text: 'hi' }),
  JSON.stringify({ type: 'exit', code: 0 }),
]
for (const e of events) writeSync(1, e + "\\n")
process.exit(0)
`;

describe("CodexSubprocessExecutor", () => {
  function makeWorkerSpec(tmp: string, config: Record<string, unknown> = {}) {
    return {
      workerId: "w1",
      repo: { name: "r", path: tmp },
      repoPath: tmp,
      taskBundle: { id: "t", description: "", payload: {}, dependsOn: [] },
      knowledgeHandle: { store: {} as never, scope: "run:x", repo: "r" },
      mailboxAddress: "m",
      config,
    };
  }

  it("refuses dynamic workflow mode without an explicit capability probe", async () => {
    const exec = new CodexSubprocessExecutor();

    await expect(exec.assertSupportsDynamicWorkflowMode()).rejects.toThrow(
      /Codex dynamic workflow subprocess mode is unavailable/,
    );
  });

  it("allows dynamic workflow mode when explicitly capability-gated", async () => {
    const exec = new CodexSubprocessExecutor({
      enableDynamicWorkflowSubprocessMode: true,
    });

    await expect(
      exec.assertSupportsDynamicWorkflowMode(),
    ).resolves.toBeUndefined();
  });

  it("refuses dynamic workflow spawns without an explicit capability probe", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fake-"));
    const exec = new CodexSubprocessExecutor();

    await expect(
      exec.spawn(makeWorkerSpec(tmp, { dynamicWorkflowMode: true })),
    ).rejects.toThrow(/Codex dynamic workflow subprocess mode is unavailable/);
  });

  it("parses output of a fake binary into WorkerEvents and exits successfully", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fake-"));
    const script = path.join(tmp, "fake.js");
    await fs.writeFile(script, fakeBin);
    const exec = new CodexSubprocessExecutor({
      command: process.execPath,
      args: [script],
    });
    const handle = await exec.spawn(makeWorkerSpec(tmp));
    const kinds: string[] = [];
    for await (const e of handle.events) kinds.push(e.kind);
    const outcome = await handle.wait();
    expect(kinds).toContain("step_start");
    expect(kinds).toContain("message");
    expect(kinds).toContain("exit");
    expect(outcome.state).toBe("completed");
  });

  it("uses codex exec JSONL stdin protocol by default", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fake-"));
    const script = path.join(tmp, "fake-codex.js");
    const argvFile = path.join(tmp, "argv.json");
    const stdinFile = path.join(tmp, "stdin.txt");
    await fs.writeFile(
      script,
      `
import { readFileSync, writeFileSync, writeSync } from "node:fs";

const stdin = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(stdinFile)}, stdin);
for (const event of [
  { type: "turn.started", turn_id: "turn-1" },
  { type: "message", role: "assistant", text: "done" },
  { type: "turn.completed", turn_id: "turn-1" },
]) {
  writeSync(1, JSON.stringify(event) + "\\n");
}
`,
    );
    const spec = makeWorkerSpec(tmp);
    spec.taskBundle = {
      id: "audit",
      description: "Audit this repo for fleet readiness",
      payload: { severity: "high" },
      dependsOn: [],
    };
    const exec = new CodexSubprocessExecutor({
      command: process.execPath,
      codexArgsPrefix: [script],
    });

    const handle = await exec.spawn(spec);
    const events = [];
    for await (const event of handle.events) events.push(event);
    const outcome = await handle.wait();

    const argv = JSON.parse(await fs.readFile(argvFile, "utf8"));
    const stdin = await fs.readFile(stdinFile, "utf8");
    expect(argv).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.4-mini",
      "--config",
      'approval_policy="never"',
      "--config",
      'model_reasoning_effort="medium"',
      "--cd",
      tmp,
      "--skip-git-repo-check",
      "-",
    ]);
    expect(stdin).toContain("Task ID: audit");
    expect(stdin).toContain("Audit this repo for fleet readiness");
    expect(stdin).toContain('"severity": "high"');
    expect(events.map((event) => event.kind)).toEqual([
      "step_start",
      "message",
      "step_done",
      "exit",
    ]);
    expect(outcome.state).toBe("completed");
  });

  it("passes configured Codex model and runtime options", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fake-"));
    const script = path.join(tmp, "fake-codex.js");
    const argvFile = path.join(tmp, "argv.json");
    await fs.writeFile(
      script,
      `
import { readFileSync, writeFileSync, writeSync } from "node:fs";

readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
writeSync(1, JSON.stringify({ type: "exit", code: 0 }) + "\\n");
`,
    );
    const exec = new CodexSubprocessExecutor({
      command: process.execPath,
      codexArgsPrefix: [script],
      model: "gpt-5.4-mini",
      reasoning: "low",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      codexConfig: {
        web_search: "disabled",
        custom_flag: true,
      },
    });

    const handle = await exec.spawn(makeWorkerSpec(tmp));
    for await (const _event of handle.events) {
      // drain
    }
    await handle.wait();

    const argv = JSON.parse(await fs.readFile(argvFile, "utf8"));
    expect(argv).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.4-mini",
      "--sandbox",
      "danger-full-access",
      "--config",
      'approval_policy="never"',
      "--config",
      'custom_flag=true',
      "--config",
      'model_reasoning_effort="low"',
      "--config",
      'sandbox_workspace_write.network_access=true',
      "--config",
      'web_search="disabled"',
      "--cd",
      tmp,
      "--skip-git-repo-check",
      "-",
    ]);
  });

  it("parses dotted Codex JSONL event names", () => {
    expect(parseCodexLine(JSON.stringify({ type: "turn.started", turn_id: "t1" }))).toMatchObject({
      kind: "step_start",
      stepId: "t1",
    });
    expect(parseCodexLine(JSON.stringify({ type: "turn.completed", turn_id: "t1" }))).toMatchObject({
      kind: "step_done",
      stepId: "t1",
    });
    expect(parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "codex" } }))).toMatchObject({
      kind: "tool_call",
      toolName: "web_search",
    });
  });

  it("throws when send() receives an unhandled WorkerInbound kind", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fake-"));
    const script = path.join(tmp, "hang.js");
    // A binary that stays alive until stdin closes
    await fs.writeFile(script, "process.stdin.resume()");
    const exec = new CodexSubprocessExecutor({
      command: process.execPath,
      args: [script],
    });
    const handle = await exec.spawn(makeWorkerSpec(tmp));
    // contract-update is a valid WorkerInbound variant — must not be silently dropped
    await expect(
      handle.send({ kind: "contract-update", surface: "test-surface" })
    ).rejects.toThrow(/contract-update/);
    await handle.cancel("cleanup");
    await handle.wait();
  });

  it("rejects live message sends after the initial prompt is submitted", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fake-"));
    const script = path.join(tmp, "hang.js");
    await fs.writeFile(script, "setTimeout(() => {}, 10000)");
    const exec = new CodexSubprocessExecutor({
      command: process.execPath,
      args: [script],
    });

    const handle = await exec.spawn(makeWorkerSpec(tmp));

    await expect(handle.send({ kind: "message", text: "continue" })).rejects.toThrow(
      /does not support live message sends/,
    );
    await handle.cancel("cleanup");
    await handle.wait();
  });
});
