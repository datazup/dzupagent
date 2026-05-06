/**
 * boundary-enforcement.test.ts
 *
 * Enforces architectural dependency rules across ALL @dzupagent/* packages by
 * parsing each package's package.json (dependencies + peerDependencies).
 *
 * This is a fast, zero-build check complementing architecture.test.ts (which
 * scans runtime import statements). Both must pass: declared deps must not
 * violate layering, and runtime imports must not violate layering.
 *
 * Rules enforced:
 *   1. Declared deps must satisfy config/architecture-boundaries.json
 *   2. Production @dzupagent/* imports must be declared in deps/peerDeps/optionalDeps
 *   3. Declared production @dzupagent/* deps must be acyclic
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Monorepo root resolution
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/testing/src/__tests__/ → four levels up → dzupagent/
const MONOREPO_ROOT = path.resolve(__dirname, '../../../..');
const PACKAGES_DIR = path.join(MONOREPO_ROOT, 'packages');
const BOUNDARY_CONFIG_PATH = path.join(MONOREPO_ROOT, 'config', 'architecture-boundaries.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageInfo {
  dirName: string;
  packageJson: PackageJson;
}

interface ForbiddenDepRule {
  /** Short name after "@dzupagent/" for the package that must not declare the dep. */
  importer: string;
  /** Short names after "@dzupagent/" that must not appear in deps or peerDeps. */
  forbidden: string[];
}

interface ArchitectureBoundaryConfig {
  packageBoundaryRules: ForbiddenDepRule[];
}

interface DepViolation {
  importer: string;
  forbidden: string;
  declaredIn: ProductionDependencyKind;
}

type ProductionDependencyKind = 'dependencies' | 'peerDependencies' | 'optionalDependencies';

// ---------------------------------------------------------------------------
// Boundary policy
// ---------------------------------------------------------------------------

function loadBoundaryConfig(configPath: string): ArchitectureBoundaryConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<ArchitectureBoundaryConfig>;

  return {
    packageBoundaryRules: Array.isArray(raw.packageBoundaryRules) ? raw.packageBoundaryRules : [],
  };
}

const BOUNDARY_CONFIG = loadBoundaryConfig(BOUNDARY_CONFIG_PATH);
const PACKAGE_BOUNDARY_RULES = BOUNDARY_CONFIG.packageBoundaryRules;

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------

/**
 * Discover all packages under packages/ that belong to @dzupagent scope.
 * Returns a map of short-name → parsed PackageJson.
 */
function discoverPackages(): Map<string, PackageInfo> {
  const map = new Map<string, PackageInfo>();

  if (!fs.existsSync(PACKAGES_DIR)) {
    return map;
  }

  for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const pkgJsonPath = path.join(PACKAGES_DIR, entry.name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;

    let parsed: PackageJson;
    try {
      parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as PackageJson;
    } catch {
      continue;
    }

    if (!parsed.name?.startsWith('@dzupagent/')) continue;

    const shortName = parsed.name.replace('@dzupagent/', '');
    map.set(shortName, {
      dirName: entry.name,
      packageJson: parsed,
    });
  }

  return map;
}

function listLocalPackageAliases(): Set<string> {
  const aliases = new Set<string>();

  if (!fs.existsSync(PACKAGES_DIR)) {
    return aliases;
  }

  for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const pkgJsonPath = path.join(PACKAGES_DIR, entry.name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;

    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as PackageJson;
      if (parsed.name?.startsWith('@dzupagent/')) {
        aliases.add(parsed.name.replace('@dzupagent/', ''));
      } else if (parsed.name) {
        aliases.add(parsed.name);
      }
    } catch {
      // ignore unparsable package.json files
    }
  }

  return aliases;
}

// ---------------------------------------------------------------------------
// Violation collector
// ---------------------------------------------------------------------------

/**
 * Extract all @dzupagent/* short names declared in production deps
 * (dependencies + peerDependencies + optionalDependencies, NOT devDependencies).
 */
function getProductionDzupDeps(
  pkg: PackageJson,
): Array<{ name: string; declaredIn: ProductionDependencyKind }> {
  const result: Array<{ name: string; declaredIn: ProductionDependencyKind }> = [];

  for (const [dep] of Object.entries(pkg.dependencies ?? {})) {
    if (dep.startsWith('@dzupagent/')) {
      result.push({ name: dep.replace('@dzupagent/', ''), declaredIn: 'dependencies' });
    }
  }

  for (const [dep] of Object.entries(pkg.peerDependencies ?? {})) {
    if (dep.startsWith('@dzupagent/')) {
      result.push({ name: dep.replace('@dzupagent/', ''), declaredIn: 'peerDependencies' });
    }
  }

  for (const [dep] of Object.entries(pkg.optionalDependencies ?? {})) {
    if (dep.startsWith('@dzupagent/')) {
      result.push({ name: dep.replace('@dzupagent/', ''), declaredIn: 'optionalDependencies' });
    }
  }

  return result;
}

function getProductionLocalDeps(
  pkg: PackageJson,
  localPackageAliases: Set<string>,
): Array<{ name: string; declaredIn: ProductionDependencyKind }> {
  const result: Array<{ name: string; declaredIn: ProductionDependencyKind }> = [];

  const collect = (
    deps: Record<string, string> | undefined,
    declaredIn: ProductionDependencyKind,
  ): void => {
    for (const [dep] of Object.entries(deps ?? {})) {
      if (dep.startsWith('@dzupagent/')) {
        result.push({ name: dep.replace('@dzupagent/', ''), declaredIn });
      } else if (localPackageAliases.has(dep)) {
        result.push({ name: dep, declaredIn });
      }
    }
  };

  collect(pkg.dependencies, 'dependencies');
  collect(pkg.peerDependencies, 'peerDependencies');
  collect(pkg.optionalDependencies, 'optionalDependencies');

  return result;
}

function getProductionDzupDepNames(pkg: PackageJson): Set<string> {
  return new Set(getProductionDzupDeps(pkg).map((dep) => dep.name));
}

function collectDepViolations(packages: Map<string, PackageInfo>): DepViolation[] {
  const violations: DepViolation[] = [];
  const localPackageAliases = listLocalPackageAliases();

  for (const rule of PACKAGE_BOUNDARY_RULES) {
    const info = packages.get(rule.importer);
    if (!info) continue; // package not present in workspace — covered by policy completeness

    const deps = getProductionLocalDeps(info.packageJson, localPackageAliases);
    for (const { name, declaredIn } of deps) {
      if (rule.forbidden.includes(name)) {
        violations.push({ importer: rule.importer, forbidden: name, declaredIn });
      }
    }
  }

  return violations;
}

function formatDepViolation(v: DepViolation): string {
  return (
    `  FORBIDDEN: @dzupagent/${v.importer} -> @dzupagent/${v.forbidden}` +
    `  (declared in ${v.declaredIn})`
  );
}

// ---------------------------------------------------------------------------
// Runtime import declaration completeness
// ---------------------------------------------------------------------------

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '__tests__' ||
        entry.name === '__fixtures__'
      ) {
        continue;
      }
      results.push(...collectSourceFiles(full));
    } else if (entry.isFile()) {
      const isTs =
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.spec.ts');
      const isVue = entry.name.endsWith('.vue');
      if (isTs || isVue) {
        results.push(full);
      }
    }
  }

  return results;
}

function isIdentifierChar(char: string | undefined): boolean {
  if (!char) return false;
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '_' ||
    char === '$'
  );
}

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function trimEndIndex(text: string): number {
  let index = text.length - 1;
  while (index >= 0 && isWhitespace(text[index])) {
    index -= 1;
  }
  return index;
}

function endsWithContextWord(text: string, word: string): boolean {
  const end = trimEndIndex(text);
  const start = end - word.length + 1;
  if (start < 0 || text.slice(start, end + 1) !== word) {
    return false;
  }

  return !isIdentifierChar(text[start - 1]);
}

function endsWithCallName(text: string, callName: string): boolean {
  let index = trimEndIndex(text);
  if (text[index] !== '(') {
    return false;
  }

  index -= 1;
  while (index >= 0 && isWhitespace(text[index])) {
    index -= 1;
  }

  const start = index - callName.length + 1;
  if (start < 0 || text.slice(start, index + 1) !== callName) {
    return false;
  }

  return !isIdentifierChar(text[start - 1]);
}

function isImportSpecifierContext(source: string, quoteIndex: number): boolean {
  const before = source.slice(Math.max(0, quoteIndex - 160), quoteIndex);

  return (
    endsWithContextWord(before, 'from') ||
    endsWithContextWord(before, 'import') ||
    endsWithCallName(before, 'import') ||
    endsWithCallName(before, 'require')
  );
}

function readQuotedSpecifier(source: string, startIndex: number, quote: string): string | undefined {
  let specifier = '';

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (char === '\\') {
      index += 1;
      continue;
    }

    if (char === quote) {
      return specifier;
    }

    specifier += char;
  }

  return undefined;
}

function addDzupagentSpecifier(found: Set<string>, specifier: string): void {
  if (!specifier.startsWith('@dzupagent/')) {
    return;
  }

  const parts = specifier.split('/');
  const packageName = `${parts[0]}/${parts[1]}`;
  found.add(packageName.replace('@dzupagent/', ''));
}

function extractDzupagentImports(filePath: string): Set<string> {
  const source = fs.readFileSync(filePath, 'utf8');
  const found = new Set<string>();

  for (let index = 0; index < source.length; index += 1) {
    const quote = source[index];
    if (quote !== "'" && quote !== '"') {
      continue;
    }

    const specifierStart = index + 1;
    if (!source.startsWith('@dzupagent/', specifierStart)) {
      continue;
    }

    if (!isImportSpecifierContext(source, index)) {
      continue;
    }

    const specifier = readQuotedSpecifier(source, specifierStart, quote);
    if (specifier) {
      addDzupagentSpecifier(found, specifier);
    }
  }

  return found;
}

interface UndeclaredRuntimeDependency {
  importer: string;
  imported: string;
  file: string;
}

function collectUndeclaredRuntimeDeps(
  packages: Map<string, PackageInfo>,
): UndeclaredRuntimeDependency[] {
  const violations: UndeclaredRuntimeDependency[] = [];

  for (const [importer, info] of packages) {
    const declaredDeps = getProductionDzupDepNames(info.packageJson);
    const srcDir = path.join(PACKAGES_DIR, info.dirName, 'src');

    for (const file of collectSourceFiles(srcDir)) {
      const imports = extractDzupagentImports(file);
      const relFile = path.relative(MONOREPO_ROOT, file);

      for (const imported of imports) {
        if (imported === importer) continue;
        if (!packages.has(imported)) continue;
        if (declaredDeps.has(imported)) continue;

        violations.push({ importer, imported, file: relFile });
      }
    }
  }

  return violations;
}

function formatUndeclaredRuntimeDep(v: UndeclaredRuntimeDependency): string {
  return (
    `  UNDECLARED: @dzupagent/${v.importer} imports @dzupagent/${v.imported}` +
    `\n  FILE:       ${v.file}`
  );
}

// ---------------------------------------------------------------------------
// Circular dependency check
// ---------------------------------------------------------------------------

interface CircularViolation {
  cycle: string[];
}

function buildProductionDepGraph(packages: Map<string, PackageInfo>): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const [shortName, info] of packages) {
    const deps = getProductionDzupDeps(info.packageJson)
      .map((dep) => dep.name)
      .filter((dep) => dep !== shortName && packages.has(dep))
      .sort();
    graph.set(shortName, deps);
  }

  return graph;
}

function canonicalCycleKey(cycle: string[]): string {
  const body = cycle.slice(0, -1);
  const rotations = body.map((_, index) => [
    ...body.slice(index),
    ...body.slice(0, index),
  ]);
  const reversed = [...body].reverse();
  rotations.push(
    ...reversed.map((_, index) => [
      ...reversed.slice(index),
      ...reversed.slice(0, index),
    ]),
  );
  return rotations.map((rotation) => rotation.join('>')).sort()[0] ?? body.join('>');
}

function collectCircularViolations(packages: Map<string, PackageInfo>): CircularViolation[] {
  const graph = buildProductionDepGraph(packages);
  const violations: CircularViolation[] = [];
  const emitted = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  function visit(node: string): void {
    if (stackIndex.has(node)) {
      const start = stackIndex.get(node)!;
      const cycle = [...stack.slice(start), node];
      const key = canonicalCycleKey(cycle);
      if (!emitted.has(key)) {
        emitted.add(key);
        violations.push({ cycle });
      }
      return;
    }

    if (visited.has(node)) return;

    visited.add(node);
    stackIndex.set(node, stack.length);
    stack.push(node);

    for (const dep of graph.get(node) ?? []) {
      visit(dep);
    }

    stack.pop();
    stackIndex.delete(node);
  }

  for (const node of [...graph.keys()].sort()) {
    visit(node);
  }

  return violations;
}

function formatCircularViolation(v: CircularViolation): string {
  return `  CIRCULAR: ${v.cycle.map((name) => `@dzupagent/${name}`).join(' -> ')}`;
}

// ---------------------------------------------------------------------------
// Dependency graph invariant helpers
// ---------------------------------------------------------------------------

/**
 * Verify that specific packages exist in the workspace.
 * Fails the test when a package is missing so we catch renames early.
 */
function assertPackageExists(packages: Map<string, PackageInfo>, shortName: string): void {
  expect(
    packages.has(shortName),
    `Expected @dzupagent/${shortName} to exist in packages/ directory`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Package boundary enforcement — workspace discovery', () => {
  const packages = discoverPackages();

  it('discovers at least 10 @dzupagent/* packages', () => {
    expect(packages.size).toBeGreaterThanOrEqual(10);
  });

  it('discovers the mandatory foundation packages', () => {
    for (const required of ['core', 'agent', 'agent-adapters', 'server', 'codegen', 'testing']) {
      assertPackageExists(packages, required);
    }
  });

  it('every discovered package has a valid name field', () => {
    for (const [shortName, info] of packages) {
      expect(
        info.packageJson.name,
        `Package at packages/${info.dirName} is missing a name field`,
      ).toBeTruthy();
      expect(info.packageJson.name).toBe(`@dzupagent/${shortName}`);
    }
  });
});

describe('Package boundary enforcement — forbidden declared dependencies', () => {
  const packages = discoverPackages();
  const localPackageAliases = listLocalPackageAliases();

  it('loads forbidden declared-dependency rules from config/architecture-boundaries.json', () => {
    expect(fs.existsSync(BOUNDARY_CONFIG_PATH)).toBe(true);
    expect(PACKAGE_BOUNDARY_RULES.length).toBeGreaterThan(0);
  });

  it('every rule lists at least one forbidden target', () => {
    const seenImporters = new Set<string>();

    for (const rule of PACKAGE_BOUNDARY_RULES) {
      expect(packages.has(rule.importer), `Rule importer @dzupagent/${rule.importer} must exist`).toBe(
        true,
      );
      expect(
        rule.forbidden.length,
        `Rule for "@dzupagent/${rule.importer}" must list at least one forbidden package`,
      ).toBeGreaterThan(0);
      expect(new Set(rule.forbidden).size).toBe(rule.forbidden.length);
      expect(seenImporters.has(rule.importer), `Duplicate rule for @dzupagent/${rule.importer}`).toBe(
        false,
      );
      seenImporters.add(rule.importer);

      for (const forbidden of rule.forbidden) {
        expect(
          localPackageAliases.has(forbidden),
          `Forbidden target ${forbidden} for @dzupagent/${rule.importer} must exist under packages/`,
        ).toBe(true);
      }
    }
  });

  it('@dzupagent/core must not declare @dzupagent/agent as a dep', () => {
    const violations = collectDepViolations(packages).filter(
      (v) => v.importer === 'core' && v.forbidden === 'agent',
    );
    expect(violations, violations.map(formatDepViolation).join('\n')).toHaveLength(0);
  });

  it('@dzupagent/core must not declare @dzupagent/server as a dep', () => {
    const violations = collectDepViolations(packages).filter(
      (v) => v.importer === 'core' && v.forbidden === 'server',
    );
    expect(violations, violations.map(formatDepViolation).join('\n')).toHaveLength(0);
  });

  it('@dzupagent/core must not declare @dzupagent/codegen as a dep', () => {
    const violations = collectDepViolations(packages).filter(
      (v) => v.importer === 'core' && v.forbidden === 'codegen',
    );
    expect(violations, violations.map(formatDepViolation).join('\n')).toHaveLength(0);
  });

  it('@dzupagent/core must not declare @dzupagent/connectors as a dep', () => {
    const violations = collectDepViolations(packages).filter(
      (v) => v.importer === 'core' && v.forbidden === 'connectors',
    );
    expect(violations, violations.map(formatDepViolation).join('\n')).toHaveLength(0);
  });

  it('@dzupagent/agent-adapters must not declare @dzupagent/server as a dep', () => {
    const violations = collectDepViolations(packages).filter(
      (v) => v.importer === 'agent-adapters' && v.forbidden === 'server',
    );
    expect(violations, violations.map(formatDepViolation).join('\n')).toHaveLength(0);
  });

  it('@dzupagent/testing must not declare @dzupagent/server as a dep', () => {
    const violations = collectDepViolations(packages).filter(
      (v) => v.importer === 'testing' && v.forbidden === 'server',
    );
    expect(violations, violations.map(formatDepViolation).join('\n')).toHaveLength(0);
  });

  it('omnibus: zero forbidden declared dependencies across all rules', () => {
    const all = collectDepViolations(packages);
    const lines = all.map(formatDepViolation);
    expect(all, `\nForbidden dependency violations:\n${lines.join('\n')}`).toHaveLength(0);
  });
});

describe('Package boundary enforcement — circular declared dependencies', () => {
  const packages = discoverPackages();

  it('production @dzupagent/* declared dependency graph is acyclic', () => {
    const violations = collectCircularViolations(packages);
    const lines = violations.map(formatCircularViolation);
    expect(violations, `\nCircular dependency violations:\n${lines.join('\n')}`).toHaveLength(0);
  });
});

describe('Package boundary enforcement — runtime import declarations', () => {
  const packages = discoverPackages();

  it('every production @dzupagent/* import is declared in deps, peerDeps, or optionalDeps', () => {
    const violations = collectUndeclaredRuntimeDeps(packages);
    const lines = violations.map(formatUndeclaredRuntimeDep);
    expect(
      violations,
      `\nUndeclared production dependency violations:\n${lines.join('\n\n')}`,
    ).toHaveLength(0);
  });
});

describe('Package boundary enforcement — dependency graph invariants', () => {
  const packages = discoverPackages();

  it('@dzupagent/core declares no production dependency on @dzupagent/agent-adapters', () => {
    const pkg = packages.get('core');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!.packageJson).map((d) => d.name);
    expect(deps).not.toContain('agent-adapters');
  });

  it('@dzupagent/agent declares no production dependency on @dzupagent/server', () => {
    const pkg = packages.get('agent');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!.packageJson).map((d) => d.name);
    expect(deps).not.toContain('server');
  });

  it('@dzupagent/testing declares no production dependency on @dzupagent/server', () => {
    const pkg = packages.get('testing');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!.packageJson).map((d) => d.name);
    expect(deps).not.toContain('server');
  });

  it('@dzupagent/test-utils declares no production dependency on @dzupagent/server', () => {
    const pkg = packages.get('test-utils');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!.packageJson).map((d) => d.name);
    expect(deps).not.toContain('server');
  });

  it('@dzupagent/evals declares no production dependency on @dzupagent/server', () => {
    const pkg = packages.get('evals');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!.packageJson).map((d) => d.name);
    expect(deps).not.toContain('server');
  });

  it('@dzupagent/memory-ipc has no @dzupagent production deps (pure foundation)', () => {
    const pkg = packages.get('memory-ipc');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!.packageJson);
    expect(deps, `memory-ipc should have zero @dzupagent deps but got: ${deps.map((d) => d.name).join(', ')}`).toHaveLength(0);
  });

  it('@dzupagent/runtime-contracts has no @dzupagent production deps (pure foundation)', () => {
    const pkg = packages.get('runtime-contracts');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!.packageJson);
    expect(deps, `runtime-contracts should have zero @dzupagent deps but got: ${deps.map((d) => d.name).join(', ')}`).toHaveLength(0);
  });
});
