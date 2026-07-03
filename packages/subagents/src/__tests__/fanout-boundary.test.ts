import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Boundary-enforcement suite (dynamic-subagents Spec 05 §4, NFR3):
 * `packages/subagents` must stay a portable layer-2 package — template-only
 * fan-out means NO sandbox/interpreter identifiers, and no imports from the
 * adapter/codegen layers. Fan-out extension points are contract-only.
 */

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = listSourceFiles(SRC_ROOT).filter((f) => f !== THIS_FILE);

// Built dynamically so this file itself never contains the banned tokens.
const BANNED_IDENTIFIERS = [
  ["quick", "js"].join(""),
  ["quick", "js-emscripten"].join(""),
  ["Wasm", "Sandbox"].join(""),
];

const BANNED_IMPORTS = [
  "@dzupagent/agent-adapters",
  "@dzupagent/codegen",
  "@dzupagent/sandbox",
];

describe("packages/subagents boundary discipline (NFR3)", () => {
  it("scans a non-empty source tree", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("contains no sandbox/interpreter identifiers anywhere in the package", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const banned of BANNED_IDENTIFIERS) {
        if (content.toLowerCase().includes(banned.toLowerCase())) {
          offenders.push(`${file} contains "${banned}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports nothing from agent-adapters, codegen, or sandbox packages", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const imports = content.matchAll(
        /(?:from\s+|import\s*\(\s*|require\s*\(\s*)"(@dzupagent\/[^"]+)"/g,
      );
      for (const match of imports) {
        const pkg = match[1] as string;
        if (BANNED_IMPORTS.some((banned) => pkg.startsWith(banned))) {
          offenders.push(`${file} imports "${pkg}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only imports @dzupagent/adapter-types, core, and hitl-kit across the package", () => {
    const allowed = new Set([
      "@dzupagent/adapter-types",
      "@dzupagent/core",
      "@dzupagent/hitl-kit",
    ]);
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const imports = content.matchAll(/from\s+"(@dzupagent\/[^"]+)"/g);
      for (const match of imports) {
        const pkg = match[1] as string;
        if (!allowed.has(pkg)) {
          offenders.push(`${file} imports "${pkg}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
