import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { MemoryServiceLike } from "@dzupagent/memory-ipc";
import { createLearningRoutes } from "../routes/learning.js";

/**
 * A memory service whose store cannot be read.
 *
 * `search` honours its documented non-fatal contract and returns [], which is
 * exactly what makes an outage indistinguishable from an empty tenant.
 */
function unreachableMemoryService(
  overrides: Partial<MemoryServiceLike> = {},
): MemoryServiceLike {
  return {
    async get() {
      return [];
    },
    async search() {
      return [];
    },
    async searchWithStatus() {
      return { results: [], searchFailed: true };
    },
    async put() {},
    async delete() {},
    ...overrides,
  } as unknown as MemoryServiceLike;
}

/** A healthy but genuinely empty store. */
function emptyMemoryService(): MemoryServiceLike {
  return {
    async get() {
      return [];
    },
    async search() {
      return [];
    },
    async searchWithStatus() {
      return { results: [], searchFailed: false };
    },
    async put() {},
    async delete() {},
  } as unknown as MemoryServiceLike;
}

function createTestApp(memoryService: MemoryServiceLike): Hono {
  const app = new Hono();
  app.route(
    "/api/learning",
    createLearningRoutes({ memoryService, defaultTenantId: "test-tenant" }),
  );
  return app;
}

describe("MemoryService satisfies the searchWithStatus port", () => {
  it("a real MemoryService actually implements searchWithStatus", async () => {
    // searchWithStatus is OPTIONAL on MemoryServiceLike, so if the real
    // implementation ever loses the method the dashboard silently falls back
    // to plain search and `partial` can never be true in production - while
    // every mock-based test above still passes. This pins the wiring.
    const { MemoryService } = await import("@dzupagent/memory");
    expect(typeof MemoryService.prototype.searchWithStatus).toBe("function");
  });
});

describe("learning dashboard — an unreachable store is not an empty one", () => {
  for (const route of ["/api/learning/dashboard", "/api/learning/overview"]) {
    describe(route, () => {
      it("marks the response partial when the store cannot be read", async () => {
        const app = createTestApp(unreachableMemoryService());
        const res = await app.request(route);
        const body = (await res.json()) as {
          success: boolean;
          partial: boolean;
          data: { lessonCount: number };
        };

        expect(res.status).toBe(200);
        expect(body.partial).toBe(true);
        // The counts are still 0 — the flag is the only thing preventing an
        // operator from reading that as "the agent has learned nothing".
        expect(body.data.lessonCount).toBe(0);
      });

      it("does not mark a genuinely empty store partial", async () => {
        // The converse. Without this, `partial: true` unconditionally would
        // also satisfy the assertion above.
        const app = createTestApp(emptyMemoryService());
        const res = await app.request(route);
        const body = (await res.json()) as {
          partial: boolean;
          data: { lessonCount: number };
        };

        expect(body.partial).toBe(false);
        expect(body.data.lessonCount).toBe(0);
      });

      it("falls back cleanly when the port lacks searchWithStatus", async () => {
        // searchWithStatus is optional on MemoryServiceLike, so every existing
        // implementation must keep working.
        const legacy = {
          async get() {
            return [];
          },
          async search() {
            return [{ text: "a lesson" }];
          },
          async put() {},
          async delete() {},
        } as unknown as MemoryServiceLike;

        const res = await createTestApp(legacy).request(route);
        const body = (await res.json()) as {
          success: boolean;
          partial: boolean;
          data: { lessonCount: number };
        };

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.partial).toBe(false);
        expect(body.data.lessonCount).toBe(1);
      });
    });
  }
});
