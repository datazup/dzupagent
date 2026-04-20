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
 *   1. @dzupagent/core must NOT depend on agent, server, codegen, connectors
 *   2. @dzupagent/agent-adapters must NOT depend on server
 *   3. @dzupagent/testing must NOT depend on server (keep test-pkg lightweight)
 *   4. No circular declared deps between core ↔ agent-adapters
 *
 * To add a rule: append an entry to FORBIDDEN_DEP_RULES below.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ForbiddenDepRule {
  /** Short name after "@dzupagent/" for the package that must not declare the dep. */
  importer: string;
  /** Short names after "@dzupagent/" that must not appear in deps or peerDeps. */
  forbidden: string[];
  /** Human-readable rationale shown in violation messages. */
  reason: string;
}

interface DepViolation {
  importer: string;
  forbidden: string;
  declaredIn: 'dependencies' | 'peerDependencies';
}

// ---------------------------------------------------------------------------
// Forbidden dependency rules
// ---------------------------------------------------------------------------

const FORBIDDEN_DEP_RULES: ForbiddenDepRule[] = [
  {
    importer: 'core',
    forbidden: ['agent', 'server', 'codegen', 'connectors'],
    reason:
      '@dzupagent/core is the foundation layer; it must not pull in higher-level packages',
  },
  {
    importer: 'agent-adapters',
    forbidden: ['server'],
    reason:
      '@dzupagent/agent-adapters must remain decoupled from the HTTP server package',
  },
  {
    importer: 'testing',
    forbidden: ['server'],
    reason:
      '@dzupagent/testing must stay lightweight and must not force-install server deps',
  },
];

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------

/**
 * Discover all packages under packages/ that belong to @dzupagent scope.
 * Returns a map of short-name → parsed PackageJson.
 */
function discoverPackages(): Map<string, PackageJson> {
  const map = new Map<string, PackageJson>();

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
    map.set(shortName, parsed);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Violation collector
// ---------------------------------------------------------------------------

/**
 * Extract all @dzupagent/* short names declared in production deps
 * (dependencies + peerDependencies, NOT devDependencies).
 */
function getProductionDzupDeps(
  pkg: PackageJson,
): Array<{ name: string; declaredIn: 'dependencies' | 'peerDependencies' }> {
  const result: Array<{ name: string; declaredIn: 'dependencies' | 'peerDependencies' }> = [];

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

  return result;
}

function collectDepViolations(packages: Map<string, PackageJson>): DepViolation[] {
  const violations: DepViolation[] = [];

  for (const rule of FORBIDDEN_DEP_RULES) {
    const pkg = packages.get(rule.importer);
    if (!pkg) continue; // package not present in workspace — skip silently

    const deps = getProductionDzupDeps(pkg);
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
// Circular dependency check (core ↔ agent-adapters)
// ---------------------------------------------------------------------------

interface CircularPair {
  a: string;
  b: string;
}

const CIRCULAR_PAIRS: CircularPair[] = [
  { a: 'core', b: 'agent-adapters' },
];

interface CircularViolation {
  a: string;
  b: string;
  direction: string;
}

function collectCircularViolations(packages: Map<string, PackageJson>): CircularViolation[] {
  const violations: CircularViolation[] = [];

  for (const { a, b } of CIRCULAR_PAIRS) {
    const pkgA = packages.get(a);
    const pkgB = packages.get(b);
    if (!pkgA || !pkgB) continue;

    const aDeps = getProductionDzupDeps(pkgA).map((d) => d.name);
    const bDeps = getProductionDzupDeps(pkgB).map((d) => d.name);

    const aImportsB = aDeps.includes(b);
    const bImportsA = bDeps.includes(a);

    if (aImportsB && bImportsA) {
      violations.push({
        a,
        b,
        direction: `@dzupagent/${a} -> @dzupagent/${b} AND @dzupagent/${b} -> @dzupagent/${a}`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Dependency graph invariant helpers
// ---------------------------------------------------------------------------

/**
 * Verify that specific packages exist in the workspace.
 * Fails the test when a package is missing so we catch renames early.
 */
function assertPackageExists(packages: Map<string, PackageJson>, shortName: string): void {
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
    for (const [shortName, pkg] of packages) {
      expect(pkg.name, `Package at packages/${shortName} is missing a name field`).toBeTruthy();
      expect(pkg.name).toBe(`@dzupagent/${shortName}`);
    }
  });
});

describe('Package boundary enforcement — forbidden declared dependencies', () => {
  const packages = discoverPackages();

  it('FORBIDDEN_DEP_RULES covers all three required importer packages', () => {
    const importers = FORBIDDEN_DEP_RULES.map((r) => r.importer).sort();
    expect(importers).toEqual(['agent-adapters', 'core', 'testing']);
  });

  it('every rule lists at least one forbidden target', () => {
    for (const rule of FORBIDDEN_DEP_RULES) {
      expect(
        rule.forbidden.length,
        `Rule for "@dzupagent/${rule.importer}" must list at least one forbidden package`,
      ).toBeGreaterThan(0);
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

  it('CIRCULAR_PAIRS contains the core ↔ agent-adapters pair', () => {
    const found = CIRCULAR_PAIRS.find((p) => p.a === 'core' && p.b === 'agent-adapters');
    expect(found).toBeDefined();
  });

  it('@dzupagent/core and @dzupagent/agent-adapters do not mutually declare each other', () => {
    const violations = collectCircularViolations(packages).filter(
      (v) => v.a === 'core' && v.b === 'agent-adapters',
    );
    const lines = violations.map((v) => `  CIRCULAR: ${v.direction}`);
    expect(violations, `\nCircular dependency violations:\n${lines.join('\n')}`).toHaveLength(0);
  });

  it('omnibus: zero circular declared dependencies across all checked pairs', () => {
    const all = collectCircularViolations(packages);
    const lines = all.map((v) => `  CIRCULAR: ${v.direction}`);
    expect(all, `\nCircular dependency violations:\n${lines.join('\n')}`).toHaveLength(0);
  });
});

describe('Package boundary enforcement — dependency graph invariants', () => {
  const packages = discoverPackages();

  it('@dzupagent/core declares no production dependency on @dzupagent/agent-adapters', () => {
    const pkg = packages.get('core');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!).map((d) => d.name);
    expect(deps).not.toContain('agent-adapters');
  });

  it('@dzupagent/agent declares no production dependency on @dzupagent/server', () => {
    const pkg = packages.get('agent');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!).map((d) => d.name);
    expect(deps).not.toContain('server');
  });

  it('@dzupagent/testing declares no production dependency on @dzupagent/server', () => {
    const pkg = packages.get('testing');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!).map((d) => d.name);
    expect(deps).not.toContain('server');
  });

  it('@dzupagent/test-utils declares no production dependency on @dzupagent/server', () => {
    const pkg = packages.get('test-utils');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!).map((d) => d.name);
    expect(deps).not.toContain('server');
  });

  it('@dzupagent/evals declares no production dependency on @dzupagent/server', () => {
    const pkg = packages.get('evals');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!).map((d) => d.name);
    expect(deps).not.toContain('server');
  });

  it('@dzupagent/memory-ipc has no @dzupagent production deps (pure foundation)', () => {
    const pkg = packages.get('memory-ipc');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!);
    expect(deps, `memory-ipc should have zero @dzupagent deps but got: ${deps.map((d) => d.name).join(', ')}`).toHaveLength(0);
  });

  it('@dzupagent/runtime-contracts has no @dzupagent production deps (pure foundation)', () => {
    const pkg = packages.get('runtime-contracts');
    expect(pkg).toBeDefined();
    const deps = getProductionDzupDeps(pkg!);
    expect(deps, `runtime-contracts should have zero @dzupagent deps but got: ${deps.map((d) => d.name).join(', ')}`).toHaveLength(0);
  });
});
