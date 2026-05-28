import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CodexSubprocessExecutor } from "../codex-subprocess-executor.js";

const fakeBin = `
const events = [
  JSON.stringify({ type: 'turn_started', turn_id: 's1' }),
  JSON.stringify({ type: 'message', role: 'assistant', text: 'hi' }),
  JSON.stringify({ type: 'exit', code: 0 }),
]
for (const e of events) console.log(e)
process.exit(0)
`;

describe("CodexSubprocessExecutor", () => {
  it("parses output of a fake binary into WorkerEvents and exits successfully", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-fake-"));
    const script = path.join(tmp, "fake.js");
    await fs.writeFile(script, fakeBin);
    const exec = new CodexSubprocessExecutor({
      command: process.execPath,
      args: [script],
    });
    const handle = await exec.spawn({
      workerId: "w1",
      repo: { name: "r", path: tmp },
      repoPath: tmp,
      taskBundle: { id: "t", description: "", payload: {}, dependsOn: [] },
      knowledgeHandle: { store: {} as never, scope: "run:x", repo: "r" },
      mailboxAddress: "m",
      config: {},
    });
    const kinds: string[] = [];
    for await (const e of handle.events) kinds.push(e.kind);
    const outcome = await handle.wait();
    expect(kinds).toContain("step_start");
    expect(kinds).toContain("message");
    expect(kinds).toContain("exit");
    expect(outcome.state).toBe("completed");
  });
});
