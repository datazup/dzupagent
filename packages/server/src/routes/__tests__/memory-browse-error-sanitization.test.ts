/**
 * ERR-M-07: `GET /:namespace` on the memory-browse route must not leak raw
 * internal error text at 500. The catch block routes through `logRouteError`
 * (sanitize + structured log) and `mapErrorToStatus`, so a thrown DB-style
 * error surfaces only the generic safe message to the client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MemoryServiceLike } from "@dzupagent/memory-ipc";

import { createMemoryBrowseRoutes } from "../memory-browse.js";

const RAW_DB_TEXT =
  "connection to db host 10.0.0.5:5432 failed: password authentication for user 'svc' failed";

/** Map-backed mock whose read paths can be made to throw a raw DB error. */
class MockMemoryService implements MemoryServiceLike {
  throwOnRead = false;

  async get(): Promise<Record<string, unknown>[]> {
    if (this.throwOnRead) throw new Error(RAW_DB_TEXT);
    return [];
  }

  async search(): Promise<Record<string, unknown>[]> {
    if (this.throwOnRead) throw new Error(RAW_DB_TEXT);
    return [];
  }

  async put(): Promise<void> {}

  async delete(): Promise<boolean> {
    return true;
  }
}

function makeApp() {
  const memoryService = new MockMemoryService();
  const app = createMemoryBrowseRoutes({ memoryService });
  return { app, memoryService };
}

describe("GET /:namespace — memory-browse error sanitization (ERR-M-07)", () => {
  let consoleErr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // logRouteError emits a structured line to stderr; silence it in the suite.
    consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErr.mockRestore();
  });

  it("returns the generic safe message, never the raw DB error, at 500", async () => {
    const { app, memoryService } = makeApp();
    memoryService.throwOnRead = true;

    const res = await app.request("/notes");
    expect(res.status).toBe(500);

    const text = await res.text();
    expect(text).not.toContain(RAW_DB_TEXT);
    expect(text).not.toContain("password authentication");
    expect(text).not.toContain("10.0.0.5");

    const body = JSON.parse(text) as {
      error?: { code?: string; message?: string };
    };
    expect(body.error?.code).toBe("MEMORY_ERROR");
    expect(body.error?.message).toBe("Internal server error");
  });

  it("emits a structured server-side log carrying the internal detail", async () => {
    const { app, memoryService } = makeApp();
    memoryService.throwOnRead = true;

    await app.request("/notes");

    expect(consoleErr).toHaveBeenCalledTimes(1);
    const logged = consoleErr.mock.calls[0]?.[0] as string;
    const entry = JSON.parse(logged) as {
      operation?: string;
      statusCode?: number;
      error?: { message?: string };
    };
    expect(entry.operation).toBe("memory.browse");
    expect(entry.statusCode).toBe(500);
    // The raw detail is preserved server-side (for operators), not to the client.
    expect(entry.error?.message).toContain("password authentication");
  });

  it("still serves the success path normally", async () => {
    const { app } = makeApp();
    const res = await app.request("/notes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: unknown[]; total?: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.total).toBe(0);
  });
});
