import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LlmRecorder, withRecordedRegistry } from "../vitest-llm-setup.js";

describe("withRecordedRegistry", () => {
  const previousKey = process.env["ANTHROPIC_API_KEY"];

  afterEach(() => {
    if (previousKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = previousKey;
  });

  it("wires an LlmRecorder instance as a registry middleware", () => {
    const { registry, recorder } = withRecordedRegistry({
      fixtureDir: `${import.meta.dirname}/__fixtures__/llm`,
    });

    expect(recorder).toBeInstanceOf(LlmRecorder);
    expect(registry.getMiddlewares()).toContain(recorder);
    expect(registry.getMiddlewares()).toHaveLength(1);
  });

  it("registers a provider that resolves models for all three tiers", () => {
    const { registry } = withRecordedRegistry({
      fixtureDir: `${import.meta.dirname}/__fixtures__/llm`,
    });

    expect(() => registry.getModel("chat")).not.toThrow();
    expect(() => registry.getModel("codegen")).not.toThrow();
    expect(() => registry.getModel("reasoning")).not.toThrow();
  });

  it("falls back to a test-key stub when ANTHROPIC_API_KEY is unset", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    // If the stub provider required a real key, constructing the chat model
    // would throw (the underlying LangChain client validates key presence).
    const { registry } = withRecordedRegistry({
      fixtureDir: `${import.meta.dirname}/__fixtures__/llm`,
    });
    expect(() => registry.getModel("chat")).not.toThrow();
  });

  it("uses ANTHROPIC_API_KEY from the environment when present", () => {
    process.env["ANTHROPIC_API_KEY"] = "env-provided-key";
    const { registry } = withRecordedRegistry({
      fixtureDir: `${import.meta.dirname}/__fixtures__/llm`,
    });
    expect(() => registry.getModel("chat")).not.toThrow();
  });

  it("returns a fresh registry and recorder on each call", () => {
    const first = withRecordedRegistry({
      fixtureDir: `${import.meta.dirname}/__fixtures__/llm`,
    });
    const second = withRecordedRegistry({
      fixtureDir: `${import.meta.dirname}/__fixtures__/llm`,
    });
    expect(first.registry).not.toBe(second.registry);
    expect(first.recorder).not.toBe(second.recorder);
  });
});
