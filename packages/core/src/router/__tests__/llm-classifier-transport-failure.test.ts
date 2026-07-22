/**
 * ERR-M-04 regression: the LLM intent classifier must distinguish a provider
 * transport failure from a genuine no-match.
 *
 * Previously `classify()` wrapped `model.invoke` in `catch { return null }`, so
 * a provider outage/timeout returned the SAME `null` as a legitimate no-match —
 * retryability was lost and provider incidents were invisible. The fix logs the
 * error and THROWS a typed, recoverable `ForgeError{ PROVIDER_UNAVAILABLE }` on
 * transport failure, while still returning `null` for a real no-match.
 *
 * IntentRouter catches that error, logs it, and marks the result
 * `transportFailed: true` while preserving its fall-through to `defaultIntent`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { LLMClassifier } from "../llm-classifier.js";
import { IntentRouter } from "../intent-router.js";
import { ForgeError } from "../../errors/forge-error.js";
import { defaultLogger } from "../../utils/logger.js";

function makeModel(
  behavior: () => Promise<{ content: unknown }>,
): BaseChatModel {
  return { invoke: vi.fn(behavior) } as unknown as BaseChatModel;
}

const PROMPT = "Classify: {message}\nIntents: {intents}";
const INTENTS = ["search", "create", "delete"];

describe("ERR-M-04 — LLMClassifier transport failure is distinct from no-match", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(defaultLogger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns null for a genuine no-match (model responded, nothing matched)", async () => {
    const model = makeModel(async () => ({
      content: "totally-unknown-intent",
    }));
    const classifier = new LLMClassifier(model, PROMPT, INTENTS);

    await expect(classifier.classify("hi")).resolves.toBeNull();
    // A genuine no-match is NOT a transport failure — nothing is logged.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws a recoverable PROVIDER_UNAVAILABLE ForgeError and logs on transport failure", async () => {
    const model = makeModel(async () => {
      throw new Error("ECONNRESET reaching provider");
    });
    const classifier = new LLMClassifier(model, PROMPT, INTENTS);

    await expect(classifier.classify("hi")).rejects.toMatchObject({
      name: "ForgeError",
      code: "PROVIDER_UNAVAILABLE",
      recoverable: true,
    });

    // The transport failure is now observable, not swallowed.
    expect(warnSpy).toHaveBeenCalledWith(
      "[core] intent classifier transport failure",
      expect.objectContaining({
        operation: "router.classify",
        error: "ECONNRESET reaching provider",
      }),
    );
  });

  it("preserves the original error as the ForgeError cause", async () => {
    const original = new Error("provider 503");
    const model = makeModel(async () => {
      throw original;
    });
    const classifier = new LLMClassifier(model, PROMPT, INTENTS);

    const caught = await classifier.classify("hi").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ForgeError);
    expect((caught as ForgeError).cause).toBe(original);
  });
});

describe("ERR-M-04 — IntentRouter surfaces transport failure distinctly from default", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(defaultLogger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('marks transportFailed=true (still confidence "default") when the LLM tier throws', async () => {
    const model = makeModel(async () => {
      throw new Error("provider down");
    });
    const router = new IntentRouter({
      keywordMatcher: { match: () => null } as never,
      llmClassifier: new LLMClassifier(model, PROMPT, INTENTS),
      defaultIntent: "chat",
    });

    const result = await router.classify("do something");
    expect(result.intent).toBe("chat");
    expect(result.confidence).toBe("default");
    expect(result.transportFailed).toBe(true);
  });

  it("a genuine no-match falls to default WITHOUT transportFailed", async () => {
    const model = makeModel(async () => ({ content: "no-such-intent" }));
    const router = new IntentRouter({
      keywordMatcher: { match: () => null } as never,
      llmClassifier: new LLMClassifier(model, PROMPT, INTENTS),
      defaultIntent: "chat",
    });

    const result = await router.classify("do something");
    expect(result.intent).toBe("chat");
    expect(result.confidence).toBe("default");
    // Distinguishable: a real no-match does NOT set transportFailed.
    expect(result.transportFailed).toBeUndefined();
  });
});
