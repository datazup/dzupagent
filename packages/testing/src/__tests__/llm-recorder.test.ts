import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmRecorder } from "../llm-recorder.js";
import type { MiddlewareContext } from "@dzupagent/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_FIXTURE_DIR = join(import.meta.dirname, "__fixtures__/llm");
const TMP_FIXTURE_PREFIX = join(tmpdir(), "dzupagent-llm-recorder-");

// `| undefined` on every override is deliberate: tests below pass
// `{ temperature: undefined }` to exercise the *unset* hashing path, and
// under `exactOptionalPropertyTypes` a bare `Partial<MiddlewareContext>`
// rejects an explicitly-undefined value.
function makeCtx(
  overrides: Omit<Partial<MiddlewareContext>, "temperature" | "maxTokens"> & {
    temperature?: MiddlewareContext["temperature"] | undefined;
    maxTokens?: MiddlewareContext["maxTokens"] | undefined;
  } = {}
): MiddlewareContext {
  return {
    messages: [{ role: "user", content: "What is 2 + 2?" }],
    model: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    ...overrides,
  } as MiddlewareContext;
}

// ---------------------------------------------------------------------------
// Demo test — replay mode using committed fixture
// ---------------------------------------------------------------------------

describe("LlmRecorder — replay mode (demo)", () => {
  it("returns the saved response without hitting the network", async () => {
    const recorder = new LlmRecorder({
      fixtureDir: FIXED_FIXTURE_DIR,
      mode: "replay",
    });
    const ctx = makeCtx();

    const result = await recorder.beforeInvoke(ctx);

    expect(result.cached).toBe(true);
    expect(result.response).toBe("2 + 2 = 4");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 9 });
  });

  it("exposes hasFixture() for test assertions", () => {
    const recorder = new LlmRecorder({
      fixtureDir: FIXED_FIXTURE_DIR,
      mode: "replay",
    });
    expect(recorder.hasFixture(makeCtx())).toBe(true);
    expect(
      recorder.hasFixture(
        makeCtx({ messages: [{ role: "user", content: "different" }] })
      )
    ).toBe(false);
  });

  it("getFixturePath() returns expected file path", () => {
    const recorder = new LlmRecorder({
      fixtureDir: FIXED_FIXTURE_DIR,
      mode: "replay",
    });
    const path = recorder.getFixturePath(makeCtx());
    expect(path).toMatch(/979e216412bab6ce\.json$/);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — replay strict mode
// ---------------------------------------------------------------------------

describe("LlmRecorder — strict replay (no fixture)", () => {
  it("throws when fixture is missing and strict=true", async () => {
    const recorder = new LlmRecorder({
      fixtureDir: FIXED_FIXTURE_DIR,
      mode: "replay",
      strict: true,
    });
    const ctx = makeCtx({
      messages: [{ role: "user", content: "no fixture for this" }],
    });

    await expect(recorder.beforeInvoke(ctx)).rejects.toThrow(
      "[LlmRecorder] No fixture found"
    );
  });

  it("returns { cached: false } when fixture is missing and strict=false", async () => {
    const recorder = new LlmRecorder({
      fixtureDir: FIXED_FIXTURE_DIR,
      mode: "replay",
      strict: false,
    });
    const ctx = makeCtx({
      messages: [{ role: "user", content: "no fixture here either" }],
    });

    const result = await recorder.beforeInvoke(ctx);
    expect(result.cached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — record mode
// ---------------------------------------------------------------------------

describe("LlmRecorder — record mode", () => {
  let tmpFixtureDir = "";

  beforeEach(() => {
    tmpFixtureDir = mkdtempSync(TMP_FIXTURE_PREFIX);
  });

  afterEach(() => {
    rmSync(tmpFixtureDir, { recursive: true, force: true });
  });

  it("passes through (cached=false) in beforeInvoke", async () => {
    const recorder = new LlmRecorder({
      fixtureDir: tmpFixtureDir,
      mode: "record",
    });
    const result = await recorder.beforeInvoke(makeCtx());
    expect(result.cached).toBe(false);
  });

  it("writes a fixture file after afterInvoke", async () => {
    const recorder = new LlmRecorder({
      fixtureDir: tmpFixtureDir,
      mode: "record",
    });
    const ctx = makeCtx();

    await recorder.afterInvoke(ctx, "the answer is 4", {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    expect(existsSync(recorder.getFixturePath(ctx))).toBe(true);
  });

  it("written fixture round-trips correctly in replay mode", async () => {
    const recorder = new LlmRecorder({
      fixtureDir: tmpFixtureDir,
      mode: "record",
    });
    const ctx = makeCtx();

    await recorder.afterInvoke(ctx, "the answer is 4", {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    // Switch to replay
    const replayer = new LlmRecorder({
      fixtureDir: tmpFixtureDir,
      mode: "replay",
    });
    const result = await replayer.beforeInvoke(ctx);

    expect(result.cached).toBe(true);
    expect(result.response).toBe("the answer is 4");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("does not write a fixture in replay mode", async () => {
    const recorder = new LlmRecorder({
      fixtureDir: tmpFixtureDir,
      mode: "replay",
      strict: false,
    });
    const ctx = makeCtx();

    await recorder.afterInvoke(ctx, "should not be written");

    expect(existsSync(recorder.getFixturePath(ctx))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — seedFixture helper
// ---------------------------------------------------------------------------

describe("LlmRecorder — seedFixture", () => {
  let tmpFixtureDir = "";

  beforeEach(() => {
    tmpFixtureDir = mkdtempSync(TMP_FIXTURE_PREFIX);
  });

  afterEach(() => {
    rmSync(tmpFixtureDir, { recursive: true, force: true });
  });

  it("seeds a fixture that replay picks up", async () => {
    const recorder = new LlmRecorder({
      fixtureDir: tmpFixtureDir,
      mode: "replay",
    });
    const ctx = makeCtx({
      messages: [{ role: "user", content: "seeded question" }],
    });

    recorder.seedFixture(ctx, "seeded answer", {
      inputTokens: 5,
      outputTokens: 3,
    });

    const result = await recorder.beforeInvoke(ctx);
    expect(result.cached).toBe(true);
    expect(result.response).toBe("seeded answer");
  });

  it("overwrites an existing fixture", async () => {
    const recorder = new LlmRecorder({
      fixtureDir: tmpFixtureDir,
      mode: "replay",
    });
    const ctx = makeCtx({
      messages: [{ role: "user", content: "overwrite me" }],
    });

    recorder.seedFixture(ctx, "first answer");
    recorder.seedFixture(ctx, "second answer");

    const result = await recorder.beforeInvoke(ctx);
    expect(result.response).toBe("second answer");
  });
});

// ---------------------------------------------------------------------------
// Unit tests — hash stability
// ---------------------------------------------------------------------------

describe("LlmRecorder — hash stability", () => {
  it("same context always resolves to the same fixture path", () => {
    const r1 = new LlmRecorder({
      fixtureDir: "/tmp/a",
      mode: "replay",
      strict: false,
    });
    const r2 = new LlmRecorder({
      fixtureDir: "/tmp/a",
      mode: "replay",
      strict: false,
    });
    const ctx = makeCtx();
    expect(r1.getFixturePath(ctx)).toBe(r2.getFixturePath(ctx));
  });

  it("different messages produce different fixture paths", () => {
    const recorder = new LlmRecorder({
      fixtureDir: "/tmp/a",
      mode: "replay",
      strict: false,
    });
    const p1 = recorder.getFixturePath(
      makeCtx({ messages: [{ role: "user", content: "a" }] })
    );
    const p2 = recorder.getFixturePath(
      makeCtx({ messages: [{ role: "user", content: "b" }] })
    );
    expect(p1).not.toBe(p2);
  });

  it("different providers produce different fixture paths", () => {
    const recorder = new LlmRecorder({
      fixtureDir: "/tmp/a",
      mode: "replay",
      strict: false,
    });
    const p1 = recorder.getFixturePath(makeCtx({ provider: "anthropic" }));
    const p2 = recorder.getFixturePath(makeCtx({ provider: "openai" }));
    expect(p1).not.toBe(p2);
  });
});

// ---------------------------------------------------------------------------
// Middleware name
// ---------------------------------------------------------------------------

describe("LlmRecorder — RegistryMiddleware contract", () => {
  it('exposes name = "llm-recorder"', () => {
    const recorder = new LlmRecorder({
      fixtureDir: "/tmp",
      mode: "replay",
      strict: false,
    });
    expect(recorder.name).toBe("llm-recorder");
  });
});

// ---------------------------------------------------------------------------
// Unit tests — hashContext optional-field branches
//
// makeCtx() always sets model+provider and never sets temperature/maxTokens,
// so those `?? ''`/`?? null` defaults in hashContext were only ever
// exercised from one side. A regression that dropped the `?? default` (e.g.
// making `undefined` and `''` hash identically to a set value) would let two
// logically different requests collide on one fixture file without any of
// the existing assertions noticing.
// ---------------------------------------------------------------------------

describe("LlmRecorder — hashContext optional-field defaults", () => {
  it("a context with model/provider omitted hashes differently than one with them set", () => {
    const recorder = new LlmRecorder({
      fixtureDir: "/tmp/a",
      mode: "replay",
      strict: false,
    });
    const withFields = recorder.getFixturePath(makeCtx());
    const withoutFields = recorder.getFixturePath({
      messages: makeCtx().messages,
    } as MiddlewareContext);
    expect(withFields).not.toBe(withoutFields);
  });

  it("different temperature values produce different fixture paths", () => {
    const recorder = new LlmRecorder({
      fixtureDir: "/tmp/a",
      mode: "replay",
      strict: false,
    });
    const p1 = recorder.getFixturePath(makeCtx({ temperature: 0.2 }));
    const p2 = recorder.getFixturePath(makeCtx({ temperature: 0.9 }));
    const pUnset = recorder.getFixturePath(makeCtx({ temperature: undefined }));
    expect(p1).not.toBe(p2);
    expect(p1).not.toBe(pUnset);
  });

  it("different maxTokens values produce different fixture paths", () => {
    const recorder = new LlmRecorder({
      fixtureDir: "/tmp/a",
      mode: "replay",
      strict: false,
    });
    const p1 = recorder.getFixturePath(makeCtx({ maxTokens: 100 }));
    const p2 = recorder.getFixturePath(makeCtx({ maxTokens: 200 }));
    const pUnset = recorder.getFixturePath(makeCtx({ maxTokens: undefined }));
    expect(p1).not.toBe(p2);
    expect(p1).not.toBe(pUnset);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — mode defaulting from LLM_RECORD env var
// ---------------------------------------------------------------------------

describe("LlmRecorder — mode resolution from LLM_RECORD env var", () => {
  const original = process.env["LLM_RECORD"];

  afterEach(() => {
    if (original === undefined) delete process.env["LLM_RECORD"];
    else process.env["LLM_RECORD"] = original;
  });

  it("defaults to replay mode when LLM_RECORD is unset and mode is not passed", async () => {
    delete process.env["LLM_RECORD"];
    const recorder = new LlmRecorder({
      fixtureDir: FIXED_FIXTURE_DIR,
      strict: false,
    });
    const ctx = makeCtx({
      messages: [{ role: "user", content: "unset env replay check" }],
    });
    const result = await recorder.beforeInvoke(ctx);
    // Replay mode with no fixture and strict=false returns cached:false;
    // record mode would instead return cached:false via the "always pass
    // through" branch too, so we distinguish by checking a fixture write
    // does NOT happen on afterInvoke (record-only behavior).
    expect(result.cached).toBe(false);
    await recorder.afterInvoke(ctx, "should not persist");
    expect(existsSync(recorder.getFixturePath(ctx))).toBe(false);
  });

  it("defaults to record mode when LLM_RECORD is set and mode is not passed", async () => {
    process.env["LLM_RECORD"] = "1";
    const tmpDir = mkdtempSync(TMP_FIXTURE_PREFIX);
    try {
      const recorder = new LlmRecorder({ fixtureDir: tmpDir });
      const ctx = makeCtx({
        messages: [{ role: "user", content: "env-driven record check" }],
      });
      await recorder.afterInvoke(ctx, "recorded via env var");
      expect(existsSync(recorder.getFixturePath(ctx))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests — usage omitted on afterInvoke/seedFixture
// ---------------------------------------------------------------------------

describe("LlmRecorder — fixture usage field is optional", () => {
  let tmpFixtureDir = "";

  beforeEach(() => {
    tmpFixtureDir = mkdtempSync(TMP_FIXTURE_PREFIX);
  });

  afterEach(() => {
    rmSync(tmpFixtureDir, { recursive: true, force: true });
  });

  it("afterInvoke without a usage argument round-trips with no usage field on replay", async () => {
    const recorder = new LlmRecorder({
      fixtureDir: tmpFixtureDir,
      mode: "record",
    });
    const ctx = makeCtx({
      messages: [{ role: "user", content: "no usage on record" }],
    });

    await recorder.afterInvoke(ctx, "answer without usage");

    const replayer = new LlmRecorder({
      fixtureDir: tmpFixtureDir,
      mode: "replay",
    });
    const result = await replayer.beforeInvoke(ctx);
    expect(result.cached).toBe(true);
    expect(result.response).toBe("answer without usage");
    expect(result.usage).toBeUndefined();
  });

  it("seedFixture without a usage argument round-trips with no usage field on replay", async () => {
    const recorder = new LlmRecorder({
      fixtureDir: tmpFixtureDir,
      mode: "replay",
    });
    const ctx = makeCtx({
      messages: [{ role: "user", content: "seed without usage" }],
    });

    recorder.seedFixture(ctx, "seeded, no usage");

    const result = await recorder.beforeInvoke(ctx);
    expect(result.cached).toBe(true);
    expect(result.usage).toBeUndefined();
  });
});
