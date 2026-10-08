import { createHash } from "node:crypto";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runDzupagentRunCli } from "../run-v2-local.js";

const FIXTURE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "v2-run"
);

const staged: string[] = [];

afterEach(async () => {
  await Promise.all(
    staged.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function stage(
  patch: Readonly<Record<string, unknown>> = {},
  files: { readonly flow: string; readonly config: string } = {
    flow: "flow.yaml",
    config: "run.json",
  }
): Promise<{ dir: string; flow: string; config: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dzup-v2-run-"));
  staged.push(dir);
  await cp(FIXTURE_DIRECTORY, dir, { recursive: true });
  const config = join(dir, files.config);
  if (Object.keys(patch).length > 0) await patchConfig(config, patch);
  return { dir, flow: join(dir, files.flow), config };
}

const CONFIG_FILES = { flow: "flow-config.yaml", config: "run-config.json" };
const CONFIG_BINDINGS = {
  primaryModel: "model-alpha",
  llmProvider: "provider-local",
  deployEnv: "env-staging",
};

function capturingImporter(invocations: unknown[]) {
  return async (url: string) => {
    const module = (await import(url)) as {
      default: (invocation: unknown) => unknown;
    };
    return {
      default: (invocation: unknown) => {
        invocations.push(invocation);
        return module.default(invocation);
      },
    };
  };
}

async function patchConfig(
  config: string,
  patch: Readonly<Record<string, unknown>>
): Promise<void> {
  const current = JSON.parse(await readFile(config, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(config, JSON.stringify({ ...current, ...patch }, null, 2));
}

function countingImporter(calls: string[]) {
  return async (url: string) => {
    const module = (await import(url)) as {
      default: (invocation: { stepId: string }) => unknown;
    };
    return {
      default: (invocation: { stepId: string }) => {
        calls.push(invocation.stepId);
        return module.default(invocation);
      },
    };
  };
}

interface CliJson {
  readonly status: string;
  readonly planSha256: string;
  readonly hostSha256: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly stepOutputs: Readonly<
    Record<string, { readonly result: unknown; readonly receipt: unknown }>
  >;
  readonly steps: readonly {
    readonly id: string;
    readonly stepSha256: string;
    readonly handler: { readonly id: string };
  }[];
  readonly errors: readonly {
    readonly code: string;
    readonly keys?: readonly string[];
  }[];
}

function parse(stdout: string): CliJson {
  return JSON.parse(stdout) as CliJson;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("dzupagent-run: run one V2 document from a file, configured by a file", () => {
  it("gate 1: runs the fixture to a completed receipt with exact step outputs", async () => {
    const { flow, config } = await stage();
    const result = await runDzupagentRunCli([flow, "--config", config]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const receipt = parse(result.stdout);
    expect(receipt).toMatchObject({
      schema: "dzupagent.v2InactiveLocalHost/v1",
      runId: "fixture-run",
      status: "completed",
      state: {
        retained: "before",
        draft: { text: "draft-done" },
        draftReceipt: { digest: "draft-digest" },
        review: { text: "review-done" },
        reviewReceipt: { digest: "review-digest" },
      },
      authority: {
        providerDispatch: false,
        workflowExternalStateMutation: false,
        deployment: false,
        activation: false,
      },
    });
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
    expect(receipt.steps.map((step) => step.handler)).toEqual([
      {
        id: "adapter-run-local.mjs",
        sha256: `sha256:${await sha256File(join(dirname(config), "adapter-run-local.mjs"))}`,
        mode: "provider-free-local",
        declaredEffects: "none",
        replay: "safe",
      },
      expect.objectContaining({ id: "adapter-run-local.mjs" }),
    ]);
  });

  it("gate 2: resumes an interrupted runId without replaying a completed step", async () => {
    const { flow, config } = await stage();
    const calls: string[] = [];
    const importModule = countingImporter(calls);

    const suspended = await runDzupagentRunCli(
      [flow, "--config", config, "--max-steps", "1"],
      { importModule }
    );
    expect(suspended.exitCode).toBe(0);
    expect(parse(suspended.stdout)).toMatchObject({
      status: "suspended",
      steps: [{ id: "draft" }],
    });
    expect(calls).toEqual(["draft"]);

    const resumed = await runDzupagentRunCli([flow, "--config", config], {
      importModule,
    });
    expect(resumed.exitCode).toBe(0);
    const receipt = parse(resumed.stdout);
    expect(receipt).toMatchObject({
      status: "completed",
      steps: [{ id: "draft" }, { id: "review" }],
    });
    expect(receipt.steps[0]?.stepSha256).toBe(
      parse(suspended.stdout).steps[0]?.stepSha256
    );
    expect(calls).toEqual(["draft", "review"]);

    const again = await runDzupagentRunCli([flow, "--config", config], {
      importModule,
    });
    expect(again.exitCode).toBe(0);
    expect(parse(again.stdout)).toEqual(receipt);
    expect(calls).toEqual(["draft", "review"]);
  });

  it("gate 3: changing only run.json changes the receipt while the flow file stays byte-identical", async () => {
    const base = await stage();
    const flowSha = await sha256File(base.flow);
    const baseline = parse(
      (await runDzupagentRunCli([base.flow, "--config", base.config])).stdout
    );

    const state = await stage({ initialState: { retained: "after" } });
    const stateReceipt = parse(
      (await runDzupagentRunCli([state.flow, "--config", state.config])).stdout
    );
    expect(stateReceipt.status).toBe("completed");
    expect(stateReceipt.state.retained).toBe("after");
    expect(baseline.state.retained).toBe("before");

    const policy = await stage({
      inheritedPolicy: { timeoutMs: 45000, budgetCents: 500 },
    });
    const policyReceipt = parse(
      (await runDzupagentRunCli([policy.flow, "--config", policy.config]))
        .stdout
    );
    expect(policyReceipt.status).toBe("completed");
    expect(policyReceipt.planSha256).not.toBe(baseline.planSha256);
    expect(policyReceipt.hostSha256).not.toBe(baseline.hostSha256);

    const handler = await stage({
      handlers: [
        {
          ref: "primitive://adapter.run@2",
          module: "./adapter-run-local-alt.mjs",
        },
      ],
    });
    const handlerReceipt = parse(
      (await runDzupagentRunCli([handler.flow, "--config", handler.config]))
        .stdout
    );
    expect(handlerReceipt.status).toBe("completed");
    expect(handlerReceipt.stepOutputs.draft?.result).toEqual({
      text: "draft-alt",
    });
    expect(baseline.stepOutputs.draft?.result).toEqual({ text: "draft-done" });
    expect(handlerReceipt.steps[0]?.handler.id).toBe("adapter-run-local-alt.mjs");

    for (const staged of [state, policy, handler]) {
      expect(await sha256File(staged.flow)).toBe(flowSha);
    }
  });

  describe("gate 4: refusals exit 1 with a diagnostic naming the key", () => {
    it("refuses an unknown config key", async () => {
      const { flow, config } = await stage({ provider: "codex" });
      const result = await runDzupagentRunCli([flow, "--config", config]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(parse(result.stderr)).toMatchObject({
        ok: false,
        errors: [{ code: "DZUPAGENT_RUN_CONFIG_INVALID", key: "provider" }],
      });
    });

    it("refuses a hostCapabilities set that is not exactly the five", async () => {
      const { flow, config } = await stage({
        hostCapabilities: [
          "flow.control.typed-condition@1",
          "flow.policy.primitive-narrowing@1",
          "flow.retry.primitive-errors@1",
          "flow.catch.primitive-terminal@1",
        ],
      });
      const result = await runDzupagentRunCli([flow, "--config", config]);
      expect(result.exitCode).toBe(1);
      expect(parse(result.stderr)).toMatchObject({
        errors: [
          { code: "DZUPAGENT_RUN_CONFIG_INVALID", key: "hostCapabilities" },
        ],
      });
    });

    it("refuses to resume when a handler module's sha256 differs from the bound one", async () => {
      const { dir, flow, config } = await stage();
      const suspended = await runDzupagentRunCli([
        flow,
        "--config",
        config,
        "--max-steps",
        "1",
      ]);
      expect(parse(suspended.stdout).status).toBe("suspended");
      await appendFile(join(dir, "adapter-run-local.mjs"), "// drift\n");

      const result = await runDzupagentRunCli([flow, "--config", config]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      const diagnostic = parse(result.stderr);
      expect(diagnostic.errors[0]).toMatchObject({
        code: "V2_LOCAL_HOST_CHECKPOINT_DRIFT",
      });
      expect(diagnostic.errors[0]?.keys).toContain("handlers");
    });

    it("refuses an inherited policy the document's own limits would widen", async () => {
      const { flow, config } = await stage({
        inheritedPolicy: { timeoutMs: 1000, budgetCents: 500 },
      });
      const result = await runDzupagentRunCli([flow, "--config", config]);
      expect(result.exitCode).toBe(1);
      expect(parse(result.stderr)).toMatchObject({
        errors: [{ code: "V2_LOCAL_HOST_PLAN_INVALID", key: "inheritedPolicy" }],
      });
    });

    it("refuses a primitive definition that carries its own semanticHash", async () => {
      const { dir, flow, config } = await stage();
      const path = join(dir, "adapter-run-v2.primitive.json");
      const definition = JSON.parse(await readFile(path, "utf8"));
      definition.compatibility.semanticHash = `sha256:${"0".repeat(64)}`;
      await writeFile(path, JSON.stringify(definition));
      const result = await runDzupagentRunCli([flow, "--config", config]);
      expect(result.exitCode).toBe(1);
      expect(parse(result.stderr)).toMatchObject({
        errors: [
          { code: "DZUPAGENT_RUN_PRIMITIVE_INVALID", key: "primitives[0]" },
        ],
      });
    });

    it("refuses a handler module without a default function export", async () => {
      const { dir, flow, config } = await stage();
      await writeFile(join(dir, "adapter-run-local.mjs"), "export const x = 1;\n");
      const result = await runDzupagentRunCli([flow, "--config", config]);
      expect(result.exitCode).toBe(1);
      expect(parse(result.stderr)).toMatchObject({
        errors: [
          { code: "DZUPAGENT_RUN_HANDLER_INVALID", key: "handlers[0].module" },
        ],
      });
    });

    it("refuses missing arguments", async () => {
      const result = await runDzupagentRunCli(["flow.yaml"]);
      expect(result.exitCode).toBe(1);
      expect(parse(result.stderr)).toMatchObject({
        errors: [{ code: "DZUPAGENT_RUN_ARGS_INVALID", key: "--config" }],
      });
    });
  });
});

describe("dzupagent-run S2B: run.json binds the document's config references", () => {
  it("S2B gate 1: binds declared references, shows them to the handler, and records only a digest", async () => {
    const { flow, config } = await stage({}, CONFIG_FILES);
    const invocations: unknown[] = [];
    const result = await runDzupagentRunCli([flow, "--config", config], {
      importModule: capturingImporter(invocations),
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(receipt.status).toBe("completed");
    expect(receipt.configSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    for (const value of Object.values(CONFIG_BINDINGS)) {
      expect(result.stdout).not.toContain(value);
    }
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations as { config: unknown }[]) {
      expect(invocation.config).toEqual(CONFIG_BINDINGS);
      expect(Object.isFrozen(invocation.config)).toBe(true);
    }
  });

  it("S2B gate 1: a document without config gets an empty frozen config and no receipt digest", async () => {
    const { flow, config } = await stage();
    const invocations: unknown[] = [];
    const result = await runDzupagentRunCli([flow, "--config", config], {
      importModule: capturingImporter(invocations),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty("configSha256");
    for (const invocation of invocations as { config: unknown }[]) {
      expect(invocation.config).toEqual({});
      expect(Object.isFrozen(invocation.config)).toBe(true);
    }
  });

  it("S2B gate 1: changing a binding value changes configSha256 and planSha256", async () => {
    const base = await stage({}, CONFIG_FILES);
    const changed = await stage(
      { config: { ...CONFIG_BINDINGS, primaryModel: "model-beta" } },
      CONFIG_FILES
    );
    const first = JSON.parse(
      (await runDzupagentRunCli([base.flow, "--config", base.config])).stdout
    ) as Record<string, unknown>;
    const second = JSON.parse(
      (await runDzupagentRunCli([changed.flow, "--config", changed.config]))
        .stdout
    ) as Record<string, unknown>;
    expect(second.configSha256).not.toBe(first.configSha256);
    expect(second.planSha256).not.toBe(first.planSha256);
  });

  describe("S2B gate 2: binding refusals exit 1 with key config.<name>", () => {
    const secret = ["sk", "-", "Zq8", "x".repeat(20)].join("");
    const cases: readonly (readonly [string, unknown, string])[] = [
      [
        "a missing declared name",
        { primaryModel: "model-alpha", llmProvider: "provider-local" },
        "config.deployEnv",
      ],
      [
        "an undeclared name",
        { ...CONFIG_BINDINGS, extraName: "x" },
        "config.extraName",
      ],
      ["a non-string value", { ...CONFIG_BINDINGS, primaryModel: 7 }, "config.primaryModel"],
      ["an empty value", { ...CONFIG_BINDINGS, primaryModel: "" }, "config.primaryModel"],
      [
        "a value over 256 characters",
        { ...CONFIG_BINDINGS, primaryModel: "m".repeat(257) },
        "config.primaryModel",
      ],
      [
        "a secret-shaped value",
        { ...CONFIG_BINDINGS, llmProvider: secret },
        "config.llmProvider",
      ],
      ["a non-object config", "model-alpha", "config"],
    ];
    for (const [label, bindings, key] of cases) {
      it(`refuses ${label}`, async () => {
        const { flow, config } = await stage({ config: bindings }, CONFIG_FILES);
        const result = await runDzupagentRunCli([flow, "--config", config]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(parse(result.stderr)).toMatchObject({
          ok: false,
          errors: [{ code: "DZUPAGENT_RUN_CONFIG_INVALID", key }],
        });
        expect(result.stderr).not.toContain(secret);
      });
    }

    it("refuses bindings for a document that declares no config", async () => {
      const { flow, config } = await stage({ config: { primaryModel: "model-alpha" } });
      const result = await runDzupagentRunCli([flow, "--config", config]);
      expect(result.exitCode).toBe(1);
      expect(parse(result.stderr)).toMatchObject({
        errors: [
          { code: "DZUPAGENT_RUN_CONFIG_INVALID", key: "config.primaryModel" },
        ],
      });
    });
  });

  it("S2B gate 3: resuming with a changed binding is refused as drift naming config", async () => {
    const { flow, config } = await stage({}, CONFIG_FILES);
    const suspended = await runDzupagentRunCli([
      flow,
      "--config",
      config,
      "--max-steps",
      "1",
    ]);
    expect(suspended.stderr).toBe("");
    expect(parse(suspended.stdout).status).toBe("suspended");
    await patchConfig(config, {
      config: { ...CONFIG_BINDINGS, deployEnv: "env-production" },
    });
    const result = await runDzupagentRunCli([flow, "--config", config]);
    expect(result.exitCode).toBe(1);
    const diagnostic = parse(result.stderr);
    expect(diagnostic.errors[0]).toMatchObject({
      code: "V2_LOCAL_HOST_CHECKPOINT_DRIFT",
    });
    expect(diagnostic.errors[0]?.keys).toContain("config");
  });
});
