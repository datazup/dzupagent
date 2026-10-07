import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIRECTORY = join(HERE, "fixtures", "v2-run");
const BIN = join(HERE, "..", "..", "bin", "run.ts");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

const staged: string[] = [];

afterEach(async () => {
  await Promise.all(
    staged.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function stage(): Promise<{ dir: string; flow: string; config: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dzup-v2-run-cli-"));
  staged.push(dir);
  await cp(FIXTURE_DIRECTORY, dir, { recursive: true });
  return { dir, flow: join(dir, "flow.yaml"), config: join(dir, "run.json") };
}

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [TSX_CLI, BIN, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("dzupagent-run subprocess", () => {
  it("gate 1: the bin runs the fixture and prints the completed receipt", async () => {
    const { flow, config } = await stage();
    const child = runCli([flow, "--config", config]);
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    const receipt = JSON.parse(child.stdout) as Record<string, unknown>;
    expect(receipt).toMatchObject({ runId: "fixture-run", status: "completed" });
    expect(receipt.stepOutputs).toEqual({
      draft: {
        result: { text: "draft-done" },
        receipt: { digest: "draft-digest" },
      },
      review: {
        result: { text: "review-done" },
        receipt: { digest: "review-digest" },
      },
    });
  }, 120_000);

  it("gate 4: the bin exits 1 and names an unknown config key", async () => {
    const { flow, config } = await stage();
    const current = JSON.parse(await readFile(config, "utf8")) as object;
    await writeFile(config, JSON.stringify({ ...current, mode: "live" }));
    const child = runCli([flow, "--config", config]);
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(JSON.parse(child.stderr)).toMatchObject({
      ok: false,
      errors: [{ code: "DZUPAGENT_RUN_CONFIG_INVALID", key: "mode" }],
    });
  }, 120_000);
});
