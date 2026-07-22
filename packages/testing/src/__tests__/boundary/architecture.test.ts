/**
 * architecture.test.ts
 *
 * Static import-graph boundary enforcement for the @dzupagent monorepo.
 *
 * Strategy: walk each package's src/ directory, collect every TypeScript
 * import specifier (static + dynamic), resolve it to a @dzupagent package
 * name, then assert that no forbidden cross-package edge appears in
 * production source files (test files are excluded).
 *
 * Also enforces that top-level app workspaces (apps/*) do not import each
 * other.  Apps MAY import @dzupagent/* packages — that is expected and is
 * intentionally NOT forbidden here.
 *
 * No build step, no external dependencies — uses only Node built-ins.
 *
 * Policy source of truth:
 *   config/architecture-boundaries.json
 *
 * This keeps boundary policy machine-readable so other tooling can adopt the
 * same rule set without duplicating arrays in test code.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Locate the monorepo root
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/testing/src/__tests__/boundary/ → five levels up → dzupagent/
const MONOREPO_ROOT = path.resolve(__dirname, "../../../../..");
// The apps/ directory lives one level above dzupagent/ in the outer monorepo.
const APPS_ROOT = path.resolve(MONOREPO_ROOT, "../apps");
const BOUNDARY_CONFIG_PATH = path.join(
  MONOREPO_ROOT,
  "config",
  "architecture-boundaries.json"
);
const PACKAGE_TIERS_PATH = path.join(
  MONOREPO_ROOT,
  "config",
  "package-tiers.json"
);
const PACKAGES_ROOT = path.join(MONOREPO_ROOT, "packages");

interface ForbiddenRule {
  /**
   * The importing package (short name after "@dzupagent/").
   */
  importer: string;
  /**
   * Target packages that the importer is forbidden from depending on
   * (short names after "@dzupagent/").
   */
  forbidden: string[];
}

interface AppForbiddenRule {
  /** Directory basename under apps/ (e.g. "codev-app"). */
  dirName: string;
  /** The npm package name from the app's package.json "name" field. */
  packageName: string;
}

interface LayerEntry {
  id: number;
  name: string;
  description?: string;
  packages: string[];
}

/**
 * A single reviewed exception to the strict lower-layer rule. Both endpoints
 * are short package names (after "@dzupagent/"). An edge listed here is a
 * governance-approved same-/cross-layer dependency and is excluded from the
 * layer-dep and static-sweep violation sets.
 */
interface AllowedLayerEdge {
  from: string;
  to: string;
  reason?: string;
  reviewedBy?: string;
}

interface LayerGraph {
  description?: string;
  layers: LayerEntry[];
  rules?: {
    allowSameLayerEdges?: boolean;
    allowedLayerEdges?: AllowedLayerEdge[];
    toolingMayBeUpstreamOfSupported?: boolean;
    toolingLayerId?: number;
    supportedTiers?: number[];
  };
}

interface ArchitectureBoundaryConfig {
  packageBoundaryRules: ForbiddenRule[];
  appWorkspaces: AppForbiddenRule[];
  layerGraph?: LayerGraph;
}

function loadBoundaryConfig(configPath: string): ArchitectureBoundaryConfig {
  const raw = JSON.parse(
    fs.readFileSync(configPath, "utf8")
  ) as Partial<ArchitectureBoundaryConfig>;

  return {
    packageBoundaryRules: Array.isArray(raw.packageBoundaryRules)
      ? raw.packageBoundaryRules
      : [],
    appWorkspaces: Array.isArray(raw.appWorkspaces) ? raw.appWorkspaces : [],
    layerGraph: raw.layerGraph,
  };
}

const BOUNDARY_CONFIG = loadBoundaryConfig(BOUNDARY_CONFIG_PATH);
const PACKAGE_BOUNDARY_RULES = BOUNDARY_CONFIG.packageBoundaryRules;
const APP_WORKSPACES = BOUNDARY_CONFIG.appWorkspaces;
const LAYER_GRAPH = BOUNDARY_CONFIG.layerGraph;

/**
 * Governance-approved same-/cross-layer edges from
 * layerGraph.rules.allowedLayerEdges, keyed by "<from>->|<to>" using short
 * package names. An edge present here is excluded from both the layer-dep and
 * static-sweep violation sets. Kept deliberately narrow: each entry is a
 * reviewed exception (see the manifest's `reason`/`reviewedBy`).
 */
function buildAllowedLayerEdgeSet(graph: LayerGraph | undefined): Set<string> {
  const out = new Set<string>();
  const edges = graph?.rules?.allowedLayerEdges;
  if (!Array.isArray(edges)) return out;
  for (const edge of edges) {
    if (typeof edge?.from === "string" && typeof edge?.to === "string") {
      out.add(`${shortNameOf(edge.from)}->|${shortNameOf(edge.to)}`);
    }
  }
  return out;
}

const ALLOWED_LAYER_EDGES = buildAllowedLayerEdgeSet(LAYER_GRAPH);

/**
 * True when the importer→dep edge is an explicitly reviewed exception in the
 * manifest allowlist. Accepts full or short package names for either endpoint.
 */
function isAllowedLayerEdge(importer: string, dep: string): boolean {
  return ALLOWED_LAYER_EDGES.has(
    `${shortNameOf(importer)}->|${shortNameOf(dep)}`
  );
}

interface TierEntry {
  tier: number;
  status: string;
  roadmapDriver?: boolean;
  owners?: string[];
}

function loadTiersConfig(): Record<string, TierEntry> {
  return JSON.parse(fs.readFileSync(PACKAGE_TIERS_PATH, "utf8")) as Record<
    string,
    TierEntry
  >;
}

const TIERS_CONFIG = loadTiersConfig();

/**
 * Walk packages/* and read each package.json `name` field.
 */
function listWorkspacePackageNames(): string[] {
  if (!fs.existsSync(PACKAGES_ROOT)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(PACKAGES_ROOT, entry.name, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        name?: string;
      };
      if (typeof json.name === "string" && json.name.length > 0) {
        out.push(json.name);
      }
    } catch {
      // ignore unparsable package.json files
    }
  }
  return out;
}

function shortNameOf(pkgName: string): string {
  if (pkgName.startsWith("@dzupagent/"))
    return pkgName.slice("@dzupagent/".length);
  return pkgName;
}

function flattenLayerGraphPackageShortNames(
  graph: LayerGraph | undefined
): Set<string> {
  const out = new Set<string>();
  if (!graph) return out;
  for (const layer of graph.layers) {
    for (const pkg of layer.packages) {
      out.add(pkg);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

/**
 * Collect all .ts and .vue source files under a directory, recursively.
 * Skips: node_modules, dist, __tests__, and any file whose basename
 * ends with .test.ts or .spec.ts — so only production source is scanned.
 */
const IGNORED_SOURCE_DIRS = new Set([
  ".cache",
  ".claude",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "storybook-static",
  "__fixtures__",
  "__tests__",
]);

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_SOURCE_DIRS.has(entry.name)) {
        continue;
      }
      results.push(...collectSourceFiles(full));
    } else if (entry.isFile()) {
      const isTs =
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".spec.ts");
      const isVue = entry.name.endsWith(".vue");
      if (isTs || isVue) {
        results.push(full);
      }
    }
  }

  return results;
}

/**
 * Extract all imported package names from a TypeScript source file.
 *
 * Covers:
 *   - static imports:  import ... from '@pkg/name'
 *   - re-exports:      export ... from '@pkg/name'
 *   - dynamic imports: import('@pkg/name')
 *   - require calls:   require('@pkg/name')
 *
 * Returns only @dzupagent/* specifiers, normalized to the package name
 * (i.e. "@dzupagent/core" even if the specifier was "@dzupagent/core/stable").
 */
function extractDzupagentImports(filePath: string): Set<string> {
  const source = fs.readFileSync(filePath, "utf8");
  const found = new Set<string>();

  // Matches both single and double-quoted specifiers.
  // Group 1 captures the full specifier (may include a sub-path).
  const IMPORT_RE =
    /(?:from|import|require)\s*\(\s*['"](@dzupagent\/[^'"]+)['"]\s*\)|(?:from)\s+['"](@dzupagent\/[^'"]+)['"]/g;

  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier) {
      // Normalise "@dzupagent/core/stable" → "@dzupagent/core"
      const parts = specifier.split("/");
      // @dzupagent/<name> — always two parts for the package name
      const pkgName = `${parts[0]}/${parts[1]}`;
      found.add(pkgName);
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Violation collectors
// ---------------------------------------------------------------------------

interface Violation {
  importer: string;
  forbidden: string;
  file: string;
}

function collectViolations(): Violation[] {
  const violations: Violation[] = [];

  for (const rule of PACKAGE_BOUNDARY_RULES) {
    const srcDir = path.join(MONOREPO_ROOT, "packages", rule.importer, "src");
    const files = collectSourceFiles(srcDir);

    for (const file of files) {
      const imports = extractDzupagentImports(file);
      const relFile = path.relative(MONOREPO_ROOT, file);

      for (const forbidden of rule.forbidden) {
        const forbiddenPkg = `@dzupagent/${forbidden}`;
        if (imports.has(forbiddenPkg)) {
          violations.push({
            importer: rule.importer,
            forbidden,
            file: relFile,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Extract all bare-package import specifiers from a source file (TS or Vue).
 * Returns specifiers that exactly match one of the provided target package names.
 *
 * Covers static imports, re-exports, dynamic imports, and require() calls.
 * Normalises sub-path imports ("pkg/sub") to just "pkg".
 */
function extractAppImports(
  filePath: string,
  targets: Set<string>
): Set<string> {
  const source = fs.readFileSync(filePath, "utf8");
  const found = new Set<string>();

  // Match any quoted specifier after from / import( / require(
  const IMPORT_RE =
    /(?:from|import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:from)\s+['"]([^'"]+)['"]/g;

  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    // Normalise scoped packages: "@scope/name/sub" → "@scope/name"
    // Normalise plain packages:  "name/sub" → "name"
    const parts = specifier.split("/");
    const pkgName = specifier.startsWith("@")
      ? `${parts[0]}/${parts[1]}`
      : parts[0];
    if (targets.has(pkgName)) {
      found.add(pkgName);
    }
  }

  return found;
}

interface AppViolation {
  importerDir: string;
  importerPkg: string;
  forbiddenPkg: string;
  file: string;
}

let cachedAppViolations: AppViolation[] | undefined;

/**
 * Scan every app workspace for imports of sibling app packages.
 * Returns one entry per (file, forbidden-package) pair found.
 */
function collectAppViolations(): AppViolation[] {
  if (cachedAppViolations) {
    return cachedAppViolations;
  }

  if (!fs.existsSync(APPS_ROOT)) {
    // apps/ directory not present (e.g. isolated dzupagent checkout) — skip.
    cachedAppViolations = [];
    return cachedAppViolations;
  }

  const violations: AppViolation[] = [];

  for (const app of APP_WORKSPACES) {
    const appDir = path.join(APPS_ROOT, app.dirName);
    const files = collectSourceFiles(appDir);

    // Forbidden targets = all OTHER apps' package names
    const forbiddenTargets = new Set(
      APP_WORKSPACES.filter((a) => a.packageName !== app.packageName).map(
        (a) => a.packageName
      )
    );

    for (const file of files) {
      const imports = extractAppImports(file, forbiddenTargets);
      const relFile = path.relative(APPS_ROOT, file);

      for (const forbiddenPkg of imports) {
        violations.push({
          importerDir: app.dirName,
          importerPkg: app.packageName,
          forbiddenPkg,
          file: relFile,
        });
      }
    }
  }

  cachedAppViolations = violations;
  return cachedAppViolations;
}

function formatAppViolations(violations: AppViolation[]): string {
  if (violations.length === 0) return "";
  const lines = violations.map(
    (v) =>
      `  FORBIDDEN: ${v.importerPkg} -> ${v.forbiddenPkg}\n  FILE:      apps/${v.file}`
  );
  return `\nCross-app boundary violations detected:\n\n${lines.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Architecture boundary rules — policy completeness", () => {
  it("loads a machine-readable boundary config from config/architecture-boundaries.json", () => {
    expect(fs.existsSync(BOUNDARY_CONFIG_PATH)).toBe(true);
    expect(PACKAGE_BOUNDARY_RULES.length).toBeGreaterThan(0);
    expect(APP_WORKSPACES.length).toBeGreaterThan(0);
  });

  it("uses unique importer package entries", () => {
    const importers = PACKAGE_BOUNDARY_RULES.map((r) => r.importer);
    expect(new Set(importers).size).toBe(importers.length);
  });

  it("every rule has at least one forbidden target", () => {
    for (const rule of PACKAGE_BOUNDARY_RULES) {
      expect(
        rule.importer.length,
        "Each package boundary rule must define a non-empty importer name"
      ).toBeGreaterThan(0);
      expect(
        rule.forbidden.length,
        `Rule for "${rule.importer}" must list at least one forbidden package`
      ).toBeGreaterThan(0);
      expect(new Set(rule.forbidden).size).toBe(rule.forbidden.length);
    }
  });

  it("uses unique app workspace directory and package name entries", () => {
    const dirs = APP_WORKSPACES.map((app) => app.dirName);
    const packageNames = APP_WORKSPACES.map((app) => app.packageName);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(new Set(packageNames).size).toBe(packageNames.length);
  });
});

// ---------------------------------------------------------------------------
// Package classification policy completeness
// ---------------------------------------------------------------------------

describe("Package classification policy completeness", () => {
  const workspacePackages = listWorkspacePackageNames();

  it("has at least one workspace package to classify", () => {
    expect(workspacePackages.length).toBeGreaterThan(0);
  });

  it("declares a layerGraph with at least one layer", () => {
    expect(
      LAYER_GRAPH,
      "config/architecture-boundaries.json must define a layerGraph"
    ).toBeDefined();
    expect(LAYER_GRAPH!.layers.length).toBeGreaterThan(0);
  });

  it("every workspace package is classified in config/package-tiers.json", () => {
    const missing = workspacePackages.filter(
      (name) => !Object.prototype.hasOwnProperty.call(TIERS_CONFIG, name)
    );
    expect(
      missing,
      `The following packages are missing from config/package-tiers.json:\n  - ${missing.join(
        "\n  - "
      )}\n\n` +
        "Add a tier entry for each new package. Tier metadata is the single source of truth for " +
        "package status and ownership."
    ).toEqual([]);
  });

  it("every workspace package is classified in the architecture layer graph", () => {
    const layerShortNames = flattenLayerGraphPackageShortNames(LAYER_GRAPH);
    const missing = workspacePackages.filter(
      (name) => !layerShortNames.has(shortNameOf(name))
    );
    expect(
      missing,
      `The following packages are missing from layerGraph in config/architecture-boundaries.json:\n  - ${missing.join(
        "\n  - "
      )}\n\n` +
        "Add each package to the lowest layer that contains all of its runtime dependencies."
    ).toEqual([]);
  });

  it("layer graph does not list a package in more than one layer", () => {
    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    for (const layer of LAYER_GRAPH?.layers ?? []) {
      for (const pkg of layer.packages) {
        if (seen.has(pkg)) {
          duplicates.push(`${pkg} (layers ${seen.get(pkg)} and ${layer.id})`);
        } else {
          seen.set(pkg, layer.id);
        }
      }
    }
    expect(duplicates).toEqual([]);
  });

  it("layer graph only references real workspace packages", () => {
    const workspaceShortNames = new Set(workspacePackages.map(shortNameOf));
    const phantom: string[] = [];
    for (const layer of LAYER_GRAPH?.layers ?? []) {
      for (const pkg of layer.packages) {
        if (!workspaceShortNames.has(pkg)) {
          phantom.push(`${pkg} (layer ${layer.id})`);
        }
      }
    }
    expect(
      phantom,
      `layerGraph references packages that do not exist under packages/:\n  - ${phantom.join(
        "\n  - "
      )}`
    ).toEqual([]);
  });
});

/**
 * One describe block per package so CI output clearly identifies which
 * package introduced the violation.
 */
for (const rule of PACKAGE_BOUNDARY_RULES) {
  describe(`Architecture boundary enforcement — @dzupagent/${rule.importer}`, () => {
    const violations = collectViolations().filter(
      (v) => v.importer === rule.importer
    );

    for (const forbidden of rule.forbidden) {
      it(`must not import @dzupagent/${forbidden}`, () => {
        const hits = violations.filter((v) => v.forbidden === forbidden);
        expect(hits, formatViolations(hits)).toHaveLength(0);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// App-to-app boundary rules — policy completeness
// ---------------------------------------------------------------------------

describe("Apps boundary rules — policy completeness", () => {
  it("every app workspace entry has a non-empty packageName", () => {
    for (const app of APP_WORKSPACES) {
      expect(
        app.dirName.length,
        "Each app workspace entry must define a non-empty directory name"
      ).toBeGreaterThan(0);
      expect(
        app.packageName.length,
        `APP_WORKSPACES entry for "${app.dirName}" must have a non-empty packageName`
      ).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// App-to-app boundary enforcement
// ---------------------------------------------------------------------------

/**
 * One describe block per app so CI output clearly identifies which app
 * introduced a cross-app import violation.
 */
describe("Apps must not import each other", () => {
  const allAppViolations = collectAppViolations();

  for (const app of APP_WORKSPACES) {
    const appViolations = allAppViolations.filter(
      (v) => v.importerDir === app.dirName
    );

    it(`${app.packageName} must not import any sibling app package`, () => {
      expect(appViolations, formatAppViolations(appViolations)).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Omnibus assertion — single test that reports ALL violations at once
// ---------------------------------------------------------------------------

describe("Architecture boundary enforcement — omnibus", () => {
  it("has zero forbidden cross-package edges across all scanned packages", () => {
    const all = collectViolations();
    expect(all, formatViolations(all)).toHaveLength(0);
  });

  it("has zero forbidden cross-app edges across all scanned app workspaces", () => {
    const all = collectAppViolations();
    expect(all, formatAppViolations(all)).toHaveLength(0);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Formatting helper
// ---------------------------------------------------------------------------

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return "";
  const lines = violations.map(
    (v) =>
      `  FORBIDDEN: @dzupagent/${v.importer} -> @dzupagent/${v.forbidden}\n  FILE:      ${v.file}`
  );
  return `\nBoundary violations detected:\n\n${lines.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Layer-driven boundary enforcement (RF-13 / ARCH-08)
//
// Dependency-order rules are driven from config/architecture-boundaries.json.
// Support/stability metadata remains in config/package-tiers.json and is checked
// separately by the completeness assertions above.
//
// Enforcement: dep.layer < importer.layer.
//   A package may depend only on packages in lower-numbered layers. This keeps
//   support tiers from being reinterpreted as architecture layers.
// ---------------------------------------------------------------------------

interface LayerDepViolation {
  importer: string;
  importerLayer: number;
  dep: string;
  depLayer: number;
}

function buildPackageLayerMap(): Map<string, number> {
  const map = new Map<string, number>();

  for (const layer of LAYER_GRAPH?.layers ?? []) {
    for (const pkg of layer.packages) {
      map.set(pkg, layer.id);
      if (pkg !== "create-dzupagent") {
        map.set(`@dzupagent/${pkg}`, layer.id);
      }
    }
  }

  return map;
}

/**
 * Read every package.json under packages/ and return the set of declared
 * local production dependencies, mapped to the package full name.
 */
function buildPackageDepMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!fs.existsSync(PACKAGES_ROOT)) return map;

  for (const entry of fs.readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(PACKAGES_ROOT, entry.name, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      if (typeof json.name !== "string" || json.name.length === 0) continue;
      const combined = {
        ...json.dependencies,
        ...json.peerDependencies,
        ...json.optionalDependencies,
      };
      const localDeps = Object.keys(combined).filter(
        (k) => k.startsWith("@dzupagent/") || k === "create-dzupagent"
      );
      map.set(json.name, localDeps);
    } catch {
      // ignore unparsable
    }
  }
  return map;
}

function collectLayerDepViolations(): LayerDepViolation[] {
  const depMap = buildPackageDepMap();
  const packageLayers = buildPackageLayerMap();
  const violations: LayerDepViolation[] = [];

  for (const [pkgName, deps] of depMap) {
    const pkgLayer = packageLayers.get(pkgName);
    if (pkgLayer === undefined) continue;

    for (const dep of deps) {
      const depLayer = packageLayers.get(dep);
      if (depLayer === undefined) continue;

      // Enforcement: packages may depend only on lower-numbered layers,
      // unless the edge is an explicitly reviewed allowlist exception.
      if (depLayer >= pkgLayer && !isAllowedLayerEdge(pkgName, dep)) {
        violations.push({
          importer: pkgName,
          importerLayer: pkgLayer,
          dep,
          depLayer,
        });
      }
    }
  }

  return violations;
}

function formatLayerDepViolations(violations: LayerDepViolation[]): string {
  if (violations.length === 0) return "";
  const lines = violations.map(
    (v) =>
      `  LAYER VIOLATION: ${v.importer} (layer ${v.importerLayer}) -> ${v.dep} (layer ${v.depLayer})` +
      `\n    Packages may depend only on lower-numbered layers.`
  );
  return (
    `\nLayer dependency violations detected:\n\n${lines.join("\n\n")}\n\n` +
    "Rule: dep.layer < importer.layer\n" +
    "Layer metadata comes from config/architecture-boundaries.json."
  );
}

// ---------------------------------------------------------------------------
// DFS-based circular dependency detection
//
// Builds a directed graph from actual TypeScript source imports (production
// files only; test files are excluded) and runs DFS cycle detection over the
// full graph.  A cycle means two or more @dzupagent packages mutually depend
// on each other at the source level, which is a hard architectural violation.
//
// The cache → memory regression example: @dzupagent/memory already depends on
// @dzupagent/cache; if cache were to import memory the DFS would detect the
// resulting cycle cache → memory → cache.
// ---------------------------------------------------------------------------

/**
 * Walk every @dzupagent package under packages/ and build an import edge
 * graph: Map<importer-pkg-name, Set<dep-pkg-name>>.
 *
 * Uses the same extractDzupagentImports() helper already defined above —
 * no duplication of regex logic.
 */
function buildImportGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  if (!fs.existsSync(PACKAGES_ROOT)) return graph;

  for (const entry of fs.readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(PACKAGES_ROOT, entry.name, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;

    let pkgName: string;
    try {
      const json = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        name?: string;
      };
      if (typeof json.name !== "string" || json.name.length === 0) continue;
      pkgName = json.name;
    } catch {
      continue;
    }

    if (!graph.has(pkgName)) {
      graph.set(pkgName, new Set<string>());
    }

    const srcDir = path.join(PACKAGES_ROOT, entry.name, "src");
    const files = collectSourceFiles(srcDir);

    for (const file of files) {
      const imports = extractDzupagentImports(file);
      for (const imp of imports) {
        if (imp !== pkgName) {
          graph.get(pkgName)!.add(imp);
        }
      }
    }
  }

  return graph;
}

interface Cycle {
  path: string[];
}

/**
 * DFS-based cycle detection over the full import graph.
 * Returns all cycles found (each cycle is reported as an ordered path where
 * the first and last node are the same package).
 *
 * Uses the standard three-colour (white/grey/black) DFS algorithm:
 *   white = not yet visited
 *   grey  = currently in the recursion stack (back-edge = cycle)
 *   black = fully processed
 */
function detectCycles(graph: Map<string, Set<string>>): Cycle[] {
  const WHITE = 0,
    GREY = 1,
    BLACK = 2;
  const colour = new Map<string, number>();
  const cycles: Cycle[] = [];
  const reportedCycles = new Set<string>();

  // Initialise all nodes white
  for (const node of graph.keys()) {
    colour.set(node, WHITE);
  }

  function dfs(node: string, stack: string[]): void {
    colour.set(node, GREY);
    stack.push(node);

    for (const neighbour of graph.get(node) ?? []) {
      if (!colour.has(neighbour)) {
        // Node outside packages/ (e.g. an external @dzupagent package not
        // in this checkout) — skip.
        continue;
      }

      if (colour.get(neighbour) === GREY) {
        // Back-edge found: extract the cycle from the current stack.
        const cycleStart = stack.indexOf(neighbour);
        const cyclePath = [...stack.slice(cycleStart), neighbour];
        // Normalise to a canonical string to deduplicate rotations.
        const canonical = [...cyclePath].sort().join("|");
        if (!reportedCycles.has(canonical)) {
          reportedCycles.add(canonical);
          cycles.push({ path: cyclePath });
        }
      } else if (colour.get(neighbour) === WHITE) {
        dfs(neighbour, stack);
      }
    }

    stack.pop();
    colour.set(node, BLACK);
  }

  for (const node of graph.keys()) {
    if (colour.get(node) === WHITE) {
      dfs(node, []);
    }
  }

  return cycles;
}

function formatCycles(cycles: Cycle[]): string {
  if (cycles.length === 0) return "";
  const lines = cycles.map((c) => `  CYCLE: ${c.path.join(" -> ")}`);
  return (
    `\nCircular dependencies detected in source import graph:\n\n${lines.join(
      "\n"
    )}\n\n` +
    "Tip: the cache -> memory case: @dzupagent/memory already depends on @dzupagent/cache;\n" +
    "if cache imports memory the DFS detects cache -> memory -> cache."
  );
}

// ---------------------------------------------------------------------------
// Static @dzupagent/ import sweep — layer ordering check
//
// Greps every production TypeScript file for  from '@dzupagent/…'  patterns.
// For each found import edge (importer-file's owning package → imported
// package) asserts that the layer ordering rule holds.
//
// This catches cases where package.json deps are correct but the source tree
// has ad-hoc cross-tier imports via path aliases or unregistered workspace
// links.
// ---------------------------------------------------------------------------

interface StaticSweepViolation {
  importerPkg: string;
  importerLayer: number;
  importedPkg: string;
  importedLayer: number;
  file: string;
}

function collectStaticSweepViolations(): StaticSweepViolation[] {
  const violations: StaticSweepViolation[] = [];
  if (!fs.existsSync(PACKAGES_ROOT)) return violations;
  const packageLayers = buildPackageLayerMap();

  for (const entry of fs.readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(PACKAGES_ROOT, entry.name, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;

    let pkgName: string;
    try {
      const json = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        name?: string;
      };
      if (typeof json.name !== "string" || json.name.length === 0) continue;
      pkgName = json.name;
    } catch {
      continue;
    }

    const pkgLayer = packageLayers.get(pkgName);
    if (pkgLayer === undefined) continue;

    const srcDir = path.join(PACKAGES_ROOT, entry.name, "src");
    const files = collectSourceFiles(srcDir);

    for (const file of files) {
      const imports = extractDzupagentImports(file);
      const relFile = path.relative(MONOREPO_ROOT, file);

      for (const imp of imports) {
        if (imp === pkgName) continue; // self-import — ignore
        const impLayer = packageLayers.get(imp);
        if (impLayer === undefined) continue;

        // Enforcement: packages may depend only on lower-numbered layers,
        // unless the edge is an explicitly reviewed allowlist exception.
        if (impLayer >= pkgLayer && !isAllowedLayerEdge(pkgName, imp)) {
          violations.push({
            importerPkg: pkgName,
            importerLayer: pkgLayer,
            importedPkg: imp,
            importedLayer: impLayer,
            file: relFile,
          });
        }
      }
    }
  }

  return violations;
}

function formatStaticSweepViolations(
  violations: StaticSweepViolation[]
): string {
  if (violations.length === 0) return "";
  const lines = violations.map(
    (v) =>
      `  STATIC SWEEP VIOLATION: ${v.importerPkg} (layer ${v.importerLayer}) imports ${v.importedPkg} (layer ${v.importedLayer})\n  FILE: ${v.file}`
  );
  return `\nStatic @dzupagent/ import sweep violations:\n\n${lines.join(
    "\n\n"
  )}`;
}

// ---------------------------------------------------------------------------
// RF-13 / ARCH-08 test suite
// ---------------------------------------------------------------------------

describe("Layer-driven dependency validation", () => {
  it("every local package dep targets a lower architecture layer", () => {
    // Rule: a package may depend only on packages in lower-numbered layers.
    //
    // Example that would fail:
    //   @dzupagent/core (layer 1) depending on @dzupagent/server (layer 5)
    const violations = collectLayerDepViolations();
    expect(violations, formatLayerDepViolations(violations)).toHaveLength(0);
  });

  it("import graph has no circular dependencies (DFS)", () => {
    // Walks every production TypeScript source file under packages/*/src/,
    // builds an import edge graph for @dzupagent/* packages, and runs a
    // full-graph DFS cycle detection.
    //
    // Regression case: if @dzupagent/cache (which is depended upon by
    // @dzupagent/memory) were to import @dzupagent/memory, this test would
    // report: CYCLE: @dzupagent/cache -> @dzupagent/memory -> @dzupagent/cache
    const graph = buildImportGraph();
    const cycles = detectCycles(graph);
    expect(cycles, formatCycles(cycles)).toHaveLength(0);
  }, 180_000);

  it("static @dzupagent/ import sweep: no forbidden cross-layer imports in source files", () => {
    // Performs a regex sweep over every production TypeScript file looking
    // for  from '@dzupagent/…'  patterns, then asserts the layer ordering
    // rule on each discovered edge.
    //
    // This test catches cross-tier source imports that may not be registered
    // in package.json (e.g. via path aliases, unregistered workspace links,
    // or accidental direct file references).
    const violations = collectStaticSweepViolations();
    expect(violations, formatStaticSweepViolations(violations)).toHaveLength(0);
  }, 180_000);
});
