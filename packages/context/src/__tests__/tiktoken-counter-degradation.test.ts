import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as NodeModule from "node:module";

/**
 * Degradation-path coverage for TiktokenCounter (DZUPAGENT-TEST-C-15).
 *
 * `tiktoken-counter.test.ts` covers routing while the optional backends are
 * installed. What stayed uncovered is every path taken when a backend is
 * ABSENT or THROWS — which is the configuration most consuming apps actually
 * run in, since `js-tiktoken` and `@anthropic-ai/tokenizer` are optional peers.
 *
 * These paths carry the `method` field that the hard-budget enforcers key on:
 * `exact`/`encoding-fallback` are adoptable, `heuristic` is not. A degradation
 * that mislabels itself as tokenizer-backed would let a caller enforce a hard
 * ceiling against a chars/4 guess.
 *
 * The module resolves its backends through `createRequire`, so `vi.mock` on
 * the packages themselves would not intercept — `node:module` is mocked instead.
 */

const requireMock = vi.hoisted(() => ({
  impl: (_id: string) => ({} as unknown),
}));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeModule>();
  return {
    ...actual,
    createRequire: () => requireMock.impl,
  };
});

/** Import fresh so the module-level backend cache starts empty. */
async function loadCounter() {
  vi.resetModules();
  const mod = await import("../tiktoken-counter.js");
  mod.__internals.resetCache();
  return mod;
}

const MISSING = (id: string) => {
  throw new Error(`Cannot find module '${id}'`);
};

beforeEach(() => {
  requireMock.impl = MISSING;
});

afterEach(() => {
  vi.resetModules();
});

describe("TiktokenCounter — no backends installed", () => {
  it("degrades to a heuristic and says so", async () => {
    const { TiktokenCounter } = await loadCounter();
    const result = new TiktokenCounter().countDetailed("hello world", "gpt-4o");
    expect(result.method).toBe("heuristic");
    expect(result.reason).toBe("optional tokenizer backend unavailable");
    expect(result.tokens).toBe(Math.ceil("hello world".length / 4));
  });

  it("still reports the model it was asked about", async () => {
    const { TiktokenCounter } = await loadCounter();
    expect(new TiktokenCounter().countDetailed("abcd", "gpt-4o").model).toBe(
      "gpt-4o"
    );
  });

  it("omits the model key entirely when none was supplied", async () => {
    const { TiktokenCounter } = await loadCounter();
    const result = new TiktokenCounter().countDetailed("abcd");
    expect("model" in result).toBe(false);
  });

  it("reports zero exact tokens for empty text without consulting a backend", async () => {
    const { TiktokenCounter } = await loadCounter();
    const result = new TiktokenCounter().countDetailed("", "gpt-4o");
    expect(result).toMatchObject({ tokens: 0, method: "exact" });
  });

  it("routes a Claude model to the heuristic when its tokenizer is absent", async () => {
    const { TiktokenCounter } = await loadCounter();
    const result = new TiktokenCounter().countDetailed(
      "hello",
      "claude-sonnet-4-6"
    );
    expect(result.method).toBe("heuristic");
  });
});

describe("TiktokenCounter — Anthropic tokenizer shapes", () => {
  const withAnthropic = (mod: unknown) => (id: string) => {
    if (id === "@anthropic-ai/tokenizer") return mod;
    throw new Error(`Cannot find module '${id}'`);
  };

  it("uses countTokens when the module exposes it", async () => {
    requireMock.impl = withAnthropic({ countTokens: () => 42 });
    const { TiktokenCounter } = await loadCounter();
    const result = new TiktokenCounter().countDetailed("x", "claude-opus-4-7");
    expect(result).toMatchObject({
      tokens: 42,
      method: "exact",
      encoding: "anthropic-tokenizer",
    });
  });

  it("accepts the snake_case count_tokens variant", async () => {
    requireMock.impl = withAnthropic({ count_tokens: () => 7 });
    const { TiktokenCounter } = await loadCounter();
    expect(
      new TiktokenCounter().countDetailed("x", "claude-opus-4-7").tokens
    ).toBe(7);
  });

  it("falls back to encode().length when no count function exists", async () => {
    requireMock.impl = withAnthropic({ encode: () => [1, 2, 3] });
    const { TiktokenCounter } = await loadCounter();
    expect(
      new TiktokenCounter().countDetailed("x", "claude-opus-4-7").tokens
    ).toBe(3);
  });

  it("reads the tokenizer off a default export", async () => {
    requireMock.impl = withAnthropic({ default: { countTokens: () => 11 } });
    const { TiktokenCounter } = await loadCounter();
    expect(
      new TiktokenCounter().countDetailed("x", "claude-opus-4-7").tokens
    ).toBe(11);
  });

  it("degrades when the module exposes no usable entry point", async () => {
    requireMock.impl = withAnthropic({ somethingElse: true });
    const { TiktokenCounter } = await loadCounter();
    expect(
      new TiktokenCounter().countDetailed("x", "claude-opus-4-7").method
    ).toBe("heuristic");
  });

  it("degrades instead of propagating when the tokenizer throws", async () => {
    requireMock.impl = withAnthropic({
      countTokens: () => {
        throw new Error("tokenizer exploded");
      },
    });
    const { TiktokenCounter } = await loadCounter();
    expect(() =>
      new TiktokenCounter().countDetailed("x", "claude-opus-4-7")
    ).not.toThrow();
    expect(
      new TiktokenCounter().countDetailed("x", "claude-opus-4-7").method
    ).toBe("heuristic");
  });

  it("rounds a fractional count up and never below zero", async () => {
    requireMock.impl = withAnthropic({ countTokens: () => 2.2 });
    const { TiktokenCounter } = await loadCounter();
    expect(
      new TiktokenCounter().countDetailed("x", "claude-opus-4-7").tokens
    ).toBe(3);

    requireMock.impl = withAnthropic({ countTokens: () => -5 });
    const fresh = await loadCounter();
    expect(
      new fresh.TiktokenCounter().countDetailed("x", "claude-opus-4-7").tokens
    ).toBe(0);
  });

  it("ignores a non-finite count and degrades", async () => {
    requireMock.impl = withAnthropic({ countTokens: () => Number.NaN });
    const { TiktokenCounter } = await loadCounter();
    expect(
      new TiktokenCounter().countDetailed("x", "claude-opus-4-7").method
    ).toBe("heuristic");
  });
});

describe("TiktokenCounter — js-tiktoken degradation", () => {
  const withTiktoken = (mod: unknown) => (id: string) => {
    if (id === "js-tiktoken") return mod;
    throw new Error(`Cannot find module '${id}'`);
  };

  const encoder = (n: number) => ({ encode: () => Array.from({ length: n }) });

  it("marks a generic encoding as encoding-fallback, not exact", async () => {
    requireMock.impl = withTiktoken({ getEncoding: () => encoder(5) });
    const { TiktokenCounter } = await loadCounter();
    // A model OUTSIDE O200K_PREFIXES with no `getEncodingNameForModel`: the
    // encoding is a generic guess, so it must not be reported as `exact`.
    // (`gpt-4o` would now be `exact` on the prefix alone — see the o200k test.)
    const result = new TiktokenCounter().countDetailed(
      "hello",
      "gpt-3.5-turbo"
    );
    expect(result).toMatchObject({
      tokens: 5,
      method: "encoding-fallback",
      encoding: "cl100k_base",
      reason: "model-specific tokenizer unavailable",
    });
  });

  it("explains the fallback differently when no model was supplied", async () => {
    requireMock.impl = withTiktoken({ getEncoding: () => encoder(5) });
    const { TiktokenCounter } = await loadCounter();
    expect(new TiktokenCounter().countDetailed("hello").reason).toBe(
      "no model identifier supplied"
    );
  });

  it("ignores a snake_case get_encoding and degrades to the heuristic", async () => {
    // `js-tiktoken` exposes camelCase only; snake_case belongs to other
    // packages, so a module offering just `get_encoding` supplies no usable
    // encoder. The counter must degrade loudly rather than silently adopt a
    // foreign API — `heuristic` is the non-adoptable classification.
    requireMock.impl = withTiktoken({ get_encoding: () => encoder(4) });
    const { TiktokenCounter } = await loadCounter();
    const result = new TiktokenCounter().countDetailed("hello");
    expect(result.method).toBe("heuristic");
    expect(result.tokens).not.toBe(4);
  });

  it("resolves gpt-4o to the o200k encoding and reports it exact", async () => {
    requireMock.impl = withTiktoken({
      getEncodingNameForModel: () => "o200k_base",
      getEncoding: () => encoder(9),
    });
    const { TiktokenCounter } = await loadCounter();
    // Counting now always goes through `getEncoding(resolveEncodingName(...))`;
    // `gpt-4o` matches O200K_PREFIXES, so the encoding is picked by prefix and
    // the result is `exact` without consulting a per-model encoder.
    expect(
      new TiktokenCounter().countDetailed("hello", "gpt-4o")
    ).toMatchObject({ tokens: 9, method: "exact", encoding: "o200k_base" });
  });

  it("falls back to the generic encoding when the model encoder throws", async () => {
    requireMock.impl = withTiktoken({
      encodingForModel: () => {
        throw new Error("unknown model");
      },
      getEncoding: () => encoder(6),
    });
    const { TiktokenCounter } = await loadCounter();
    expect(
      new TiktokenCounter().countDetailed("hello", "gpt-9z")
    ).toMatchObject({ tokens: 6, method: "encoding-fallback" });
  });

  it("falls back when the module offers no model encoder at all", async () => {
    requireMock.impl = withTiktoken({ getEncoding: () => encoder(6) });
    const { TiktokenCounter } = await loadCounter();
    // `gpt-3.5-turbo` is not an O200K prefix, and without
    // `getEncodingNameForModel` there is nothing model-specific to trust.
    expect(
      new TiktokenCounter().countDetailed("hello", "gpt-3.5-turbo").method
    ).toBe("encoding-fallback");
  });

  it("degrades to a heuristic when the generic encoder also throws", async () => {
    requireMock.impl = withTiktoken({
      getEncoding: () => {
        throw new Error("no encoding");
      },
    });
    const { TiktokenCounter } = await loadCounter();
    expect(
      new TiktokenCounter().countDetailed("hello", "gpt-4o")
    ).toMatchObject({
      method: "heuristic",
      reason: "tokenizer encoding failed",
    });
  });

  it("degrades when the module exposes no encoder functions", async () => {
    requireMock.impl = withTiktoken({});
    const { TiktokenCounter } = await loadCounter();
    expect(new TiktokenCounter().countDetailed("hello", "gpt-4o").method).toBe(
      "heuristic"
    );
  });

  it("count() agrees with countDetailed().tokens on a degraded path", async () => {
    requireMock.impl = withTiktoken({ getEncoding: () => encoder(5) });
    const { TiktokenCounter } = await loadCounter();
    const counter = new TiktokenCounter();
    expect(counter.count("hello", "gpt-4o")).toBe(
      counter.countDetailed("hello", "gpt-4o").tokens
    );
  });
});

describe("TiktokenCounter — backend cache", () => {
  it("resolves each backend once and reuses the result", async () => {
    let calls = 0;
    requireMock.impl = (id: string) => {
      calls += 1;
      if (id === "js-tiktoken")
        return { getEncoding: () => ({ encode: () => [1] }) };
      throw new Error(`Cannot find module '${id}'`);
    };
    const { TiktokenCounter } = await loadCounter();
    const counter = new TiktokenCounter();
    counter.countDetailed("a");
    counter.countDetailed("b");
    counter.countDetailed("c");
    expect(calls).toBe(1);
  });

  it("re-resolves after resetCache()", async () => {
    let calls = 0;
    requireMock.impl = (id: string) => {
      calls += 1;
      if (id === "js-tiktoken")
        return { getEncoding: () => ({ encode: () => [1] }) };
      throw new Error(`Cannot find module '${id}'`);
    };
    const { TiktokenCounter, __internals } = await loadCounter();
    const counter = new TiktokenCounter();
    counter.countDetailed("a");
    __internals.resetCache();
    counter.countDetailed("b");
    expect(calls).toBe(2);
  });
});
