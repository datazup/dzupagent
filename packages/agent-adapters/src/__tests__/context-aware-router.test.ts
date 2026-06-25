import { describe, it, expect, beforeEach } from "vitest";

import {
  ContextAwareRouter,
  ContextInjectionMiddleware,
} from "../context/context-aware-router.js";
import type { ContextInjection } from "../context/context-aware-router.js";
import type { AgentInput, TaskDescriptor } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(
  prompt: string,
  overrides?: Partial<TaskDescriptor>
): TaskDescriptor {
  return {
    prompt,
    tags: [],
    ...overrides,
  };
}

function makeInput(
  prompt: string,
  overrides?: Partial<AgentInput>
): AgentInput {
  return {
    prompt,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ContextAwareRouter tests
// ---------------------------------------------------------------------------

describe("ContextAwareRouter", () => {
  let router: ContextAwareRouter;

  beforeEach(() => {
    router = new ContextAwareRouter();
  });

  describe("estimateContext", () => {
    it("returns a token estimate for a prompt", () => {
      // Default estimator: ~4 chars/token
      const input = makeInput("a".repeat(400)); // ~100 tokens
      const estimate = router.estimateContext(input);

      expect(estimate.inputTokens).toBe(100);
      expect(estimate.outputTokens).toBe(4000); // default
      expect(estimate.totalTokens).toBe(4100);
      expect(estimate.fitsInContext).toBe(true);
    });

    it("includes system prompt in estimate", () => {
      const input = makeInput("a".repeat(400), {
        systemPrompt: "b".repeat(400),
      });
      const estimate = router.estimateContext(input);

      expect(estimate.inputTokens).toBe(200); // 100 + 100
    });

    it("includes injections in estimate", () => {
      const input = makeInput("a".repeat(400));
      const injections: ContextInjection[] = [
        { label: "ctx", content: "c".repeat(400), priority: 1 },
      ];
      const estimate = router.estimateContext(input, injections);

      // 100 (prompt) + 100 (injection content) + label overhead + separator overhead
      expect(estimate.inputTokens).toBeGreaterThan(200);
    });
  });

  describe("route", () => {
    it("routes to provider with sufficient context window", () => {
      const task = makeTask("Simple question");
      const decision = router.route(task, ["claude", "codex"]);

      expect(decision.provider).toBe("claude"); // claude is first in priority
      expect(decision.confidence).toBeGreaterThan(0);
    });

    it("routes to gemini for very large context", () => {
      // Create a prompt that exceeds claude's effective window (200k * 0.8 = 160k tokens)
      // At 4 chars/token, need >640k chars + 4000 output tokens
      const bigPrompt = "x".repeat(700_000); // ~175k tokens
      const task = makeTask(bigPrompt);

      const decision = router.route(task, ["claude", "gemini"]);

      // Total ~175k + 4k = 179k, claude effective = 160k -- doesn't fit
      // gemini effective = 800k -- fits
      expect(decision.provider).toBe("gemini");
    });

    it("filters out providers with insufficient context window", () => {
      // crush has 32k context, effective = 25.6k
      // Need a prompt > 25.6k - 4k = 21.6k tokens = 86.4k chars
      const mediumPrompt = "x".repeat(100_000); // ~25k tokens + 4k output = 29k
      const task = makeTask(mediumPrompt);

      const decision = router.route(task, ["crush", "codex"]);

      // crush can't handle it, codex (128k * 0.8 = 102.4k) can
      expect(decision.provider).toBe("codex");
    });

    it("applies safety margin", () => {
      const customRouter = new ContextAwareRouter({ safetyMargin: 0.5 });
      // claude: 200k * 0.5 = 100k effective
      const prompt = "x".repeat(400_000); // ~100k tokens + 4k output = 104k
      const task = makeTask(prompt);

      const decision = customRouter.route(task, ["claude", "gemini"]);

      // claude effective = 100k, total needed = 104k -- doesn't fit
      expect(decision.provider).toBe("gemini");
    });

    it("respects preferred provider when it fits", () => {
      const task = makeTask("Short question", {
        preferredProvider: "codex",
      });

      const decision = router.route(task, ["claude", "codex", "gemini"]);

      expect(decision.provider).toBe("codex");
      expect(decision.confidence).toBe(0.95);
    });

    it("prioritizes claude before openrouter when both fit", () => {
      const task = makeTask("Short question");

      const decision = router.route(task, ["openrouter", "claude"]);

      expect(decision.provider).toBe("claude");
      expect(decision.fallbackProviders).toEqual(["openrouter"]);
    });

    it("respects preferred openrouter when it fits", () => {
      const task = makeTask("Short question", {
        preferredProvider: "openrouter",
      });

      const decision = router.route(task, ["claude", "openrouter"]);

      expect(decision.provider).toBe("openrouter");
      expect(decision.confidence).toBe(0.95);
    });

    it("returns auto when no providers available", () => {
      const task = makeTask("Question");
      const decision = router.route(task, []);

      expect(decision.provider).toBe("auto");
      expect(decision.confidence).toBe(0);
    });

    it("falls back to first available when nothing fits and gemini is unavailable", () => {
      // Huge prompt that nothing can handle
      const hugePrompt = "x".repeat(5_000_000); // ~1.25M tokens
      const task = makeTask(hugePrompt);

      const decision = router.route(task, ["claude", "codex"]);

      // No gemini available, falls back to first: claude
      expect(decision.provider).toBe("claude");
      expect(decision.confidence).toBeLessThan(0.4);
    });
  });

  describe("canHandle", () => {
    it("returns true when estimate fits", () => {
      const fits = router.canHandle("claude", {
        inputTokens: 1000,
        outputTokens: 4000,
        totalTokens: 5000,
        fitsInContext: true,
      });

      expect(fits).toBe(true);
    });

    it("returns false when estimate exceeds effective window", () => {
      const fits = router.canHandle("crush", {
        inputTokens: 30_000,
        outputTokens: 4000,
        totalTokens: 34_000,
        fitsInContext: true,
      });

      // crush effective = 32k * 0.8 = 25.6k
      expect(fits).toBe(false);
    });
  });

  describe("custom token estimator", () => {
    it("uses the custom estimator", () => {
      const custom = new ContextAwareRouter({
        tokenEstimator: (text) => text.length, // 1 char = 1 token
      });

      const input = makeInput("hello"); // 5 chars = 5 tokens
      const estimate = custom.estimateContext(input);

      expect(estimate.inputTokens).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // M-09 — route() must include systemPrompt in token count
  // -------------------------------------------------------------------------

  describe("route() — M-09 systemPrompt token inclusion", () => {
    it("includes systemPrompt tokens in routing decision when present", () => {
      // crush effective window = 32_000 * 0.8 = 25_600 tokens
      // At 4 chars/token:
      //   prompt       = 1_000 chars  →    250 tokens
      //   systemPrompt = 90_000 chars → 22_500 tokens
      //   output est   =               4_000 tokens
      //
      // Without systemPrompt: 250 + 4_000 = 4_250 → fits crush (25_600)
      // With systemPrompt:   22_500 + 250 + 4_000 = 26_750 → exceeds crush
      //   codex effective = 128_000 * 0.8 = 102_400 → fits
      //
      // We use crush as the sole provider for "without" to confirm it fits,
      // then crush+codex for "with" to confirm crush is skipped and codex wins.
      const smallPrompt = "x".repeat(1_000); // 250 tokens
      const largeSystemPrompt = "s".repeat(90_000); // 22_500 tokens

      const taskWithSystem = makeTask(smallPrompt, {
        systemPrompt: largeSystemPrompt,
      });
      const taskWithoutSystem = makeTask(smallPrompt);

      // Offer only crush — it fits when systemPrompt is absent
      const decisionWithout = router.route(taskWithoutSystem, ["crush"]);
      expect(decisionWithout.provider).toBe("crush");

      // With systemPrompt added: crush no longer fits, codex steps in
      const decisionWith = router.route(taskWithSystem, ["crush", "codex"]);
      expect(decisionWith.provider).toBe("codex");
    });

    it("uses estimatedInputTokens directly when provided, skipping re-estimation", () => {
      // crush effective = 25_600. Provide estimatedInputTokens > 25_600 - 4_000 = 21_600
      // so total = 22_000 + 4_000 = 26_000 → exceeds crush, routes to codex
      const task = makeTask("short prompt", {
        estimatedInputTokens: 22_000,
      });

      // crush alone cannot handle 26_000 tokens → falls back (confidence low)
      // codex (102_400 effective) can handle it
      const decision = router.route(task, ["crush", "codex"]);
      expect(decision.provider).toBe("codex");
    });

    it("estimatedInputTokens takes precedence over systemPrompt text", () => {
      // If estimatedInputTokens is provided, the router uses it even when
      // systemPrompt is also present — the caller's pre-computed value wins.
      // Use a tiny estimatedInputTokens so crush is selected despite a large systemPrompt.
      // Offer crush as the only provider so priority ordering does not interfere.
      const task = makeTask("short", {
        systemPrompt: "s".repeat(200_000), // would be 50_000 tokens if counted
        estimatedInputTokens: 100, // caller says: only 100 tokens
      });

      // 100 + 4_000 = 4_100 → fits crush (25_600 effective)
      const decision = router.route(task, ["crush"]);
      expect(decision.provider).toBe("crush");
    });

    it("preferred provider check also accounts for systemPrompt", () => {
      // crush effective = 25_600. systemPrompt alone = 22_500 tokens + prompt 250 + output 4_000 = 26_750
      // → preferred crush should be overridden and fall through to non-preferred logic
      const task = makeTask("x".repeat(1_000), {
        preferredProvider: "crush",
        systemPrompt: "s".repeat(90_000),
      });

      const decision = router.route(task, ["crush", "codex"]);

      // crush preferred but doesn't fit with systemPrompt → falls through to codex
      expect(decision.provider).toBe("codex");
    });
  });
});

// ---------------------------------------------------------------------------
// ContextInjectionMiddleware tests
// ---------------------------------------------------------------------------

describe("ContextInjectionMiddleware", () => {
  describe("addInjection / clearInjections", () => {
    it("adds and clears injections", () => {
      const middleware = new ContextInjectionMiddleware();

      middleware.addInjection({ label: "A", content: "aaa", priority: 1 });
      middleware.addInjection({ label: "B", content: "bbb", priority: 2 });

      expect(middleware.getInjections()).toHaveLength(2);

      middleware.clearInjections();
      expect(middleware.getInjections()).toHaveLength(0);
    });

    it("sorts by priority descending", () => {
      const middleware = new ContextInjectionMiddleware();

      middleware.addInjection({ label: "Low", content: "l", priority: 1 });
      middleware.addInjection({ label: "High", content: "h", priority: 10 });
      middleware.addInjection({ label: "Mid", content: "m", priority: 5 });

      const sorted = middleware.getInjections();
      expect(sorted[0]!.label).toBe("High");
      expect(sorted[1]!.label).toBe("Mid");
      expect(sorted[2]!.label).toBe("Low");
    });
  });

  describe("apply", () => {
    it("prepends injected context to prompt by default", () => {
      const middleware = new ContextInjectionMiddleware();
      middleware.addInjection({
        label: "Context",
        content: "Some context",
        priority: 1,
      });

      const input = makeInput("What is this?");
      const result = middleware.apply(input);

      expect(result.prompt).toContain("[Context]");
      expect(result.prompt).toContain("Some context");
      expect(result.prompt).toContain("What is this?");
      // Context should come before the prompt
      const contextIdx = result.prompt.indexOf("[Context]");
      const promptIdx = result.prompt.indexOf("What is this?");
      expect(contextIdx).toBeLessThan(promptIdx);
    });

    it("injects into system prompt when position is system", () => {
      const middleware = new ContextInjectionMiddleware({ position: "system" });
      middleware.addInjection({
        label: "Sys",
        content: "System info",
        priority: 1,
      });

      const input = makeInput("Question", { systemPrompt: "Existing system" });
      const result = middleware.apply(input);

      expect(result.systemPrompt).toContain("Existing system");
      expect(result.systemPrompt).toContain("[Sys]");
      expect(result.systemPrompt).toContain("System info");
      // Prompt should be unchanged
      expect(result.prompt).toBe("Question");
    });

    it("respects token budget and drops optional injections", () => {
      // 1 char = 1 token with our custom estimator
      const middleware = new ContextInjectionMiddleware(
        { maxContextTokens: 50 },
        (text) => text.length
      );

      middleware.addInjection({
        label: "Big",
        content: "x".repeat(100),
        priority: 1,
        required: false,
      });
      middleware.addInjection({
        label: "Small",
        content: "y".repeat(10),
        priority: 2,
        required: false,
      });

      const input = makeInput("Hello");
      const result = middleware.apply(input);

      // Only Small should fit within 50 tokens
      expect(result.prompt).toContain("[Small]");
      expect(result.prompt).not.toContain("[Big]");
    });

    it("always includes required injections even over budget", () => {
      const middleware = new ContextInjectionMiddleware(
        { maxContextTokens: 10 },
        (text) => text.length
      );

      middleware.addInjection({
        label: "Required",
        content: "x".repeat(100),
        priority: 1,
        required: true,
      });

      const input = makeInput("Hello");
      const result = middleware.apply(input);

      expect(result.prompt).toContain("[Required]");
    });

    it("returns input unchanged when no injections", () => {
      const middleware = new ContextInjectionMiddleware();
      const input = makeInput("Hello");
      const result = middleware.apply(input);

      expect(result).toBe(input); // Same reference
    });

    it("injects system prompt when no existing system prompt", () => {
      const middleware = new ContextInjectionMiddleware({ position: "system" });
      middleware.addInjection({ label: "Info", content: "data", priority: 1 });

      const input = makeInput("Question");
      const result = middleware.apply(input);

      expect(result.systemPrompt).toContain("[Info]");
      expect(result.systemPrompt).toContain("data");
    });
  });

  describe("enrichInput", () => {
    it("computes available budget from provider context window", () => {
      const router = new ContextAwareRouter();
      const middleware = new ContextInjectionMiddleware();

      middleware.addInjection({
        label: "Ctx",
        content: "Extra context",
        priority: 1,
      });

      const input = makeInput("Simple prompt");
      const enriched = middleware.enrichInput(input, "claude", router);

      expect(enriched.prompt).toContain("[Ctx]");
      expect(enriched.prompt).toContain("Simple prompt");
    });
  });
});
