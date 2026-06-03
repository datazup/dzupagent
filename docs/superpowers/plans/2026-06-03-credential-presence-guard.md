# Credential Presence Guard at Adapter Init — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `GeminiSDKAdapter` credential guard so a missing `GOOGLE_API_KEY` throws a clear `ForgeError(ADAPTER_EXECUTION_FAILED)` rather than being silently swallowed by the SDK-import catch block and re-thrown as `ADAPTER_SDK_NOT_INSTALLED`.

**Architecture:** The bug is in `gemini-sdk-adapter.ts:loadSDK()` — the key check happens _inside_ a `try/catch` whose `catch` overwrites any thrown error with a generic SDK-not-installed message. The fix moves the key resolution and guard to _before_ the `try` block, matching the pattern used by `openai-http.ts:resolveOpenAIApiKey()`. OpenAI is already correct and needs no changes. Claude/Codex/GeminiCLI adapters use ambient CLI auth (not API keys) and are out of scope.

**Tech Stack:** TypeScript, Vitest, `@dzupagent/core` `ForgeError`

---

## Files

- **Modify:** `packages/agent-adapters/src/gemini/gemini-sdk-adapter.ts` — fix `loadSDK()` credential guard (lines 265–292)
- **Modify:** `packages/agent-adapters/src/__tests__/gemini-sdk-adapter.test.ts` — add tests for missing-key and empty-string-key error paths

---

### Task 1: Fix `GeminiSDKAdapter.loadSDK()` credential guard

**Files:**

- Modify: `packages/agent-adapters/src/gemini/gemini-sdk-adapter.ts:265-292`

- [ ] **Step 1: Write the failing tests**

Open `packages/agent-adapters/src/__tests__/gemini-sdk-adapter.test.ts`. After the existing `describe('GeminiSDKAdapter', ...)` block's last `it(...)` test, add a new describe block:

```typescript
describe("credential guard", () => {
  it("throws ADAPTER_EXECUTION_FAILED when no API key is set", async () => {
    const { GeminiSDKAdapter: Fresh } = await import(
      "../gemini/gemini-sdk-adapter.js?t=no-key"
    );
    const adapter = new Fresh({}); // no googleApiKey, no apiKey
    const savedEnv = process.env["GOOGLE_API_KEY"];
    delete process.env["GOOGLE_API_KEY"];
    try {
      await expect(
        collectEvents(adapter.execute({ prompt: "hi", sessionId: "s1" }))
      ).rejects.toMatchObject({
        code: "ADAPTER_EXECUTION_FAILED",
        message: expect.stringContaining("GOOGLE_API_KEY"),
      });
    } finally {
      if (savedEnv !== undefined) process.env["GOOGLE_API_KEY"] = savedEnv;
    }
  });

  it("throws ADAPTER_EXECUTION_FAILED when apiKey is an empty string", async () => {
    const { GeminiSDKAdapter: Fresh } = await import(
      "../gemini/gemini-sdk-adapter.js?t=empty-key"
    );
    const adapter = new Fresh({ apiKey: "" });
    const savedEnv = process.env["GOOGLE_API_KEY"];
    delete process.env["GOOGLE_API_KEY"];
    try {
      await expect(
        collectEvents(adapter.execute({ prompt: "hi", sessionId: "s1" }))
      ).rejects.toMatchObject({
        code: "ADAPTER_EXECUTION_FAILED",
        message: expect.stringContaining("GOOGLE_API_KEY"),
      });
    } finally {
      if (savedEnv !== undefined) process.env["GOOGLE_API_KEY"] = savedEnv;
    }
  });

  it("does NOT throw when GOOGLE_API_KEY env var is set", async () => {
    // This test verifies the env fallback still works; the SDK is mocked so
    // execute() will throw at the first model call, not at credential resolution.
    const { GeminiSDKAdapter: Fresh } = await import(
      "../gemini/gemini-sdk-adapter.js?t=env-key"
    );
    const adapter = new Fresh({}); // no explicit key
    process.env["GOOGLE_API_KEY"] = "env-test-key";
    try {
      // loadSDK() should succeed (SDK mock returns MockGoogleGenerativeAI).
      // The execute() call will fail on the model mock (not configured),
      // but that error must NOT be ADAPTER_EXECUTION_FAILED with missing-key message.
      mockGenerateContentStream.mockRejectedValueOnce(
        new Error("mock-model-error")
      );
      const events = await collectEvents(
        adapter.execute({ prompt: "hi", sessionId: "s1" })
      ).catch((e: unknown) => e);
      // We just need to verify it did not throw a missing-key error.
      if (events instanceof Error || events instanceof ForgeError) {
        expect(
          (events as ForgeError).message ?? (events as Error).message
        ).not.toContain("GOOGLE_API_KEY");
      }
    } finally {
      delete process.env["GOOGLE_API_KEY"];
    }
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

```bash
node ../../node_modules/vitest/vitest.mjs run src/__tests__/gemini-sdk-adapter.test.ts -t "credential guard" 2>&1 | tail -20
```

Expected: the first two tests FAIL (currently the missing-key error is swallowed and rethrown as `ADAPTER_SDK_NOT_INSTALLED`), third test may pass or fail.

- [ ] **Step 3: Fix `loadSDK()` in `gemini-sdk-adapter.ts`**

Replace the current `loadSDK()` method (lines 265–292) with:

```typescript
  private async loadSDK(): Promise<GeminiSDK> {
    if (this.sdk) return this.sdk
    // Resolve the API key before attempting the SDK import so a missing key
    // surfaces as a clear ADAPTER_EXECUTION_FAILED rather than being swallowed
    // by the import catch block.
    const apiKey =
      this.config.googleApiKey ?? this.config.apiKey ?? process.env['GOOGLE_API_KEY']
    if (!apiKey) {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message:
          'Google API key required. Set GOOGLE_API_KEY or pass googleApiKey in config.',
        recoverable: false,
        context: { providerId: 'gemini-sdk', reason: 'missing_api_key' },
      })
    }
    try {
      const mod = await import(/* webpackIgnore: true */ '@google/generative-ai')
      this.sdk = new mod.GoogleGenerativeAI(apiKey) as unknown as GeminiSDK
      return this.sdk
    } catch (cause: unknown) {
      // Re-throw as a structured error only if it is not already a ForgeError.
      if (cause instanceof ForgeError) throw cause
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message:
          'Failed to load @google/generative-ai. Install it: yarn add @google/generative-ai',
        recoverable: false,
        suggestion: 'yarn add @google/generative-ai',
        context: { providerId: 'gemini-sdk', sdkPackage: '@google/generative-ai' },
      })
    }
  }
```

- [ ] **Step 4: Run the credential-guard tests to verify they pass**

```bash
node ../../node_modules/vitest/vitest.mjs run src/__tests__/gemini-sdk-adapter.test.ts -t "credential guard" 2>&1 | tail -15
```

Expected: all 3 credential guard tests pass.

- [ ] **Step 5: Run the full gemini-sdk-adapter test file to confirm no regressions**

```bash
node ../../node_modules/vitest/vitest.mjs run src/__tests__/gemini-sdk-adapter.test.ts 2>&1 | tail -8
```

Expected: all tests pass.

- [ ] **Step 6: Run the full agent-adapters suite**

```bash
node ../../node_modules/vitest/vitest.mjs run 2>&1 | tail -8
```

Expected: all tests pass, no regressions.

- [ ] **Step 7: Typecheck agent-adapters**

```bash
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json 2>&1 | tail -5
```

Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-adapters/src/gemini/gemini-sdk-adapter.ts \
        packages/agent-adapters/src/__tests__/gemini-sdk-adapter.test.ts
git commit -m "fix(agent-adapters): surface missing GOOGLE_API_KEY as ADAPTER_EXECUTION_FAILED (Tier-4 cred guard)"
```

---

## Self-Review

**Spec coverage:**

- ✅ Missing key (no config, no env) → `ADAPTER_EXECUTION_FAILED` with `GOOGLE_API_KEY` in message — Task 1 case 1
- ✅ Empty string key → same error — Task 1 case 2
- ✅ Env fallback still works — Task 1 case 3
- ✅ SDK-not-installed path (import fails) still throws `ADAPTER_SDK_NOT_INSTALLED` — preserved in catch block
- ✅ Already-loaded SDK cache path unchanged (`if (this.sdk) return this.sdk`)

**Placeholder scan:** None found — all steps have concrete code and commands.

**Type consistency:** `ForgeError` import already present in the file. `GeminiSDKAdapterConfig` unchanged. `loadSDK()` signature unchanged.

**Note on test isolation:** The tests use `?t=<tag>` query params on the dynamic import URL to bust Vitest's module cache, getting a fresh `GeminiSDKAdapter` class for each env-manipulation test. This avoids the cached `this.sdk` field from a prior test leaking key state.
