/**
 * Pins WHERE the route-error surface is published, not merely THAT it exists.
 *
 * The sanitisation chokepoint (ERR-C-04 / SEC-M-14) landed on the root barrel
 * in eabf1ffa, which broke the growth-frozen barrel budget (34 -> 44 lines).
 * It was relocated to the `@dzupagent/express/route-error` subpath.
 *
 * The relocation is safe precisely because the surface was never published
 * from the root: before eabf1ffa the root barrel had zero route-error
 * re-exports and package.json exported only ".". Re-adding a root re-export
 * "for published-consumer compatibility" is therefore a no-op for consumers
 * and a regression against the budget, so this test asserts the root barrel
 * stays clear of it — the direction a green suite would otherwise miss.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("route-error subpath placement", () => {
  it("publishes the sanitisation surface on the ./route-error subpath", async () => {
    const entry = await import("../route-error-public.js");

    expect(typeof entry.routeError).toBe("function");
    expect(typeof entry.sanitizeError).toBe("function");
    expect(typeof entry.toError).toBe("function");
    expect(typeof entry.isClientSafeError).toBe("function");
    expect(typeof entry.ClientSafeError).toBe("function");
    expect(entry.GENERIC_ERROR_CODE).toBe("INTERNAL_ERROR");
    expect(entry.GENERIC_ERROR_MESSAGE).toBe("Internal error");
  });

  it("maps the subpath in package.json so the entry is importable", () => {
    const pkg = JSON.parse(read("../../package.json")) as {
      exports: Record<string, { import: string; types: string }>;
    };

    expect(pkg.exports["./route-error"]).toEqual({
      import: "./dist/route-error-public.js",
      types: "./dist/route-error-public.d.ts",
    });
  });

  it("keeps the root barrel free of route-error re-exports", () => {
    // Asserted against source, not the module namespace: a root re-export is
    // exactly what regresses the barrel budget, and importing the barrel
    // would not reveal WHERE a symbol was re-exported from.
    expect(read("../index.ts")).not.toMatch(/route-error/);
  });
});
