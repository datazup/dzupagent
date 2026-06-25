import { describe, expect, it, vi } from "vitest";

import { AdapterLearningLoop } from "../learning/adapter-learning-loop.js";
import type { ExecutionRecord } from "../learning/adapter-learning-loop.js";
import {
  buildPreflightValidator,
  budgetSanityValidator,
  skillToolCoverageValidator,
  skillDegradationValidator,
} from "../guardrails/preflight-validator.js";
import type { AgentInput, AgentEvent } from "../types.js";
import { BaseCliAdapter } from "../base/base-cli-adapter.js";
import { ForgeError } from "@dzupagent/core/events";

// ---------------------------------------------------------------------------
// process-helpers mock — required because BaseCliAdapter imports spawn utilities
// ---------------------------------------------------------------------------

vi.mock("../utils/process-helpers.js", () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn().mockImplementation(async function* () {}),
}));

const baseInput: AgentInput = { prompt: "do work" };

describe("PreflightValidator (P2)", () => {
  describe("budgetSanityValidator", () => {
    it("passes when no budget is set", async () => {
      const result = await budgetSanityValidator.validate(baseInput, {
        providerId: "claude",
      });
      expect(result.ok).toBe(true);
    });

    it("fails when budget is zero or negative", async () => {
      const result = await budgetSanityValidator.validate(
        { ...baseInput, maxBudgetUsd: 0 },
        { providerId: "claude" }
      );
      expect(result.ok).toBe(false);
      expect(result.issues[0]!.code).toBe("budget.exhausted");
    });

    it("passes when budget is positive", async () => {
      const result = await budgetSanityValidator.validate(
        { ...baseInput, maxBudgetUsd: 5 },
        { providerId: "claude" }
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("skillToolCoverageValidator", () => {
    it("warns when skills are declared without required tools", async () => {
      const result = await skillToolCoverageValidator.validate(baseInput, {
        providerId: "claude",
        skillIds: ["sql-gen"],
        requiredTools: [],
      });
      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]!.severity).toBe("warning");
      expect(result.issues[0]!.code).toBe("skill.tools_missing");
    });

    it("passes when skills + tools are aligned", async () => {
      const result = await skillToolCoverageValidator.validate(baseInput, {
        providerId: "claude",
        skillIds: ["sql-gen"],
        requiredTools: ["execute_sql"],
      });
      expect(result.issues).toHaveLength(0);
    });

    it("passes when no skills are declared", async () => {
      const result = await skillToolCoverageValidator.validate(baseInput, {
        providerId: "claude",
      });
      expect(result.issues).toHaveLength(0);
    });
  });

  describe("skillDegradationValidator", () => {
    it("warns when a requested skill is degraded for the provider", async () => {
      const loop = new AdapterLearningLoop({
        minSampleSize: 1,
        skillHealthThresholds: { minSamples: 3, degradedBelow: 0.5 },
      });
      for (let i = 0; i < 4; i++) {
        loop.record({
          providerId: "claude",
          taskType: "general",
          tags: [],
          success: false,
          durationMs: 100,
          inputTokens: 100,
          outputTokens: 50,
          costCents: 1,
          timestamp: Date.now(),
          skillIds: ["degraded-skill"],
        } satisfies ExecutionRecord);
      }

      const validator = skillDegradationValidator(loop);
      const result = await validator.validate(baseInput, {
        providerId: "claude",
        skillIds: ["degraded-skill"],
      });
      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]!.code).toBe("skill.degraded");
    });

    it("passes silently when no degradation is observed", async () => {
      const loop = new AdapterLearningLoop({ minSampleSize: 1 });
      const validator = skillDegradationValidator(loop);
      const result = await validator.validate(baseInput, {
        providerId: "claude",
        skillIds: ["unknown-skill"],
      });
      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  describe("buildPreflightValidator (composed)", () => {
    it("aggregates issues across all built-in validators", async () => {
      const validator = buildPreflightValidator();
      const result = await validator.validate(
        { ...baseInput, maxBudgetUsd: -1 },
        { providerId: "claude", skillIds: ["x"], requiredTools: [] }
      );
      // budget error + skill-tools warning
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
      expect(result.issues.some((i) => i.code === "budget.exhausted")).toBe(
        true
      );
      expect(result.issues.some((i) => i.code === "skill.tools_missing")).toBe(
        true
      );
    });

    it("runs the degradation validator only when a learning loop is supplied", async () => {
      const loop = new AdapterLearningLoop({
        minSampleSize: 1,
        skillHealthThresholds: { minSamples: 1, degradedBelow: 0.99 },
      });
      loop.record({
        providerId: "claude",
        taskType: "general",
        tags: [],
        success: false,
        durationMs: 100,
        inputTokens: 100,
        outputTokens: 50,
        costCents: 1,
        timestamp: Date.now(),
        skillIds: ["s"],
      });

      const validator = buildPreflightValidator({ learningLoop: loop });
      const result = await validator.validate(baseInput, {
        providerId: "claude",
        skillIds: ["s"],
        requiredTools: ["t"],
      });
      expect(result.issues.some((i) => i.code === "skill.degraded")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// M-10 — assertReady() enforces preflight validator in BaseCliAdapter
// ---------------------------------------------------------------------------

/**
 * Minimal concrete subclass used to test BaseCliAdapter.assertReady().
 * We expose assertReady() publicly so tests can call it directly.
 */
class TestableCliAdapter extends BaseCliAdapter {
  constructor(config?: ConstructorParameters<typeof BaseCliAdapter>[1]) {
    super("gemini", config);
  }

  // Expose for direct testing
  async runAssertReady(input: AgentInput): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).assertReady(input);
  }

  protected getBinaryName(): string {
    return "test-bin";
  }

  protected buildArgs(_input: AgentInput): string[] {
    return ["--prompt", _input.prompt];
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string
  ): AgentEvent | undefined {
    if (record["type"] === "completed") {
      return {
        type: "adapter:completed",
        providerId: this.providerId,
        sessionId,
        result: String(record["result"] ?? "done"),
        durationMs: 0,
        timestamp: Date.now(),
      };
    }
    return undefined;
  }
}

describe("BaseCliAdapter.assertReady() — M-10 preflight enforcement", () => {
  it("throws before any spawn when maxBudgetUsd is zero", async () => {
    const adapter = new TestableCliAdapter();
    const input: AgentInput = { prompt: "do work", maxBudgetUsd: 0 };

    await expect(adapter.runAssertReady(input)).rejects.toThrow(
      /Preflight validation failed/
    );
    await expect(adapter.runAssertReady(input)).rejects.toThrow(
      /budget\.exhausted/
    );
  });

  it("throws a ForgeError with code VALIDATION_FAILED when budget is zero", async () => {
    const adapter = new TestableCliAdapter();
    const input: AgentInput = { prompt: "do work", maxBudgetUsd: 0 };

    let thrown: unknown;
    try {
      await adapter.runAssertReady(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ForgeError);
    expect((thrown as ForgeError).code).toBe("VALIDATION_FAILED");
    expect((thrown as ForgeError).message).toMatch(
      /Preflight validation failed/
    );
  });

  it("throws when maxBudgetUsd is negative", async () => {
    const adapter = new TestableCliAdapter();
    const input: AgentInput = { prompt: "do work", maxBudgetUsd: -5 };

    await expect(adapter.runAssertReady(input)).rejects.toThrow(
      /Preflight validation failed/
    );
  });

  it("throws a ForgeError (not a plain Error) when maxBudgetUsd is negative", async () => {
    const adapter = new TestableCliAdapter();
    const input: AgentInput = { prompt: "do work", maxBudgetUsd: -5 };

    let thrown: unknown;
    try {
      await adapter.runAssertReady(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ForgeError);
    expect(ForgeError.is(thrown)).toBe(true);
  });

  it("does not throw when maxBudgetUsd is positive", async () => {
    const adapter = new TestableCliAdapter();
    const input: AgentInput = { prompt: "do work", maxBudgetUsd: 1.0 };

    await expect(adapter.runAssertReady(input)).resolves.toBeUndefined();
  });

  it("does not throw when maxBudgetUsd is absent", async () => {
    const adapter = new TestableCliAdapter();
    const input: AgentInput = { prompt: "do work" };

    await expect(adapter.runAssertReady(input)).resolves.toBeUndefined();
  });

  it("throws before execute() yields any events when budget is exhausted", async () => {
    const adapter = new TestableCliAdapter();
    const input: AgentInput = { prompt: "do work", maxBudgetUsd: 0 };

    const gen = adapter.execute(input);
    await expect(gen.next()).rejects.toThrow(/Preflight validation failed/);
  });

  it("execute() throws a ForgeError (not plain Error) when budget is exhausted", async () => {
    const adapter = new TestableCliAdapter();
    const input: AgentInput = { prompt: "do work", maxBudgetUsd: 0 };

    const gen = adapter.execute(input);
    let thrown: unknown;
    try {
      await gen.next();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ForgeError);
    expect((thrown as ForgeError).code).toBe("VALIDATION_FAILED");
  });
});
