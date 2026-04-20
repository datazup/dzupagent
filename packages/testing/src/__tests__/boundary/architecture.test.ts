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
 * To extend: add an entry to FORBIDDEN_EDGES or APP_FORBIDDEN_EDGES below.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Locate the monorepo root
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/testing/src/__tests__/boundary/ → five levels up → dzupagent/
const MONOREPO_ROOT = path.resolve(__dirname, '../../../../..');
// The apps/ directory lives one level above dzupagent/ in the outer monorepo.
const APPS_ROOT = path.resolve(MONOREPO_ROOT, '../apps');

// ---------------------------------------------------------------------------
// Forbidden-edge map
//
// Shape: { importer: string; forbidden: string[] }[]
//
// Each entry declares that the source package MUST NOT contain any
// production import of the listed target packages.
//
// Extend this list to enforce new architectural constraints without
// touching any other part of the file.
// ---------------------------------------------------------------------------

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

const FORBIDDEN_EDGES: ForbiddenRule[] = [
  {
    importer: 'core',
    forbidden: ['agent', 'codegen', 'connectors', 'server', 'agent-adapters'],
  },
  {
    importer: 'agent',
    forbidden: ['server'],
  },
  {
    importer: 'codegen',
    forbidden: ['agent', 'server', 'connectors'],
  },
  {
    importer: 'connectors',
    forbidden: ['agent', 'codegen', 'server'],
  },
  {
    importer: 'agent-adapters',
    forbidden: ['server'],
  },
  {
    importer: 'server',
    forbidden: ['playground', 'create-dzupagent', 'testing', 'test-utils'],
  },
];

// ---------------------------------------------------------------------------
// App-to-app forbidden edges
//
// Scanning granularity: top-level app workspaces (apps/<name>/) only.
// codev-app's internal sub-workspaces (@codev-app/web, @codev-app/api) are
// treated as internal concerns of codev-app and are NOT listed as peer apps
// here — cross-imports between them are codev-app's own business, not a
// monorepo boundary violation.
//
// Package names below come from each app's package.json "name" field.
// ---------------------------------------------------------------------------

interface AppForbiddenRule {
  /** Directory basename under apps/ (e.g. "codev-app"). */
  dirName: string;
  /** The npm package name from the app's package.json "name" field. */
  packageName: string;
}

/**
 * Every top-level app workspace that participates in cross-app enforcement.
 * Each entry is forbidden from importing any OTHER entry's packageName.
 */
const APP_WORKSPACES: AppForbiddenRule[] = [
  { dirName: 'ai-saas-starter-kit', packageName: 'ai-saas-starter-kit' },
  { dirName: 'blood-pressure', packageName: 'blood-pressure' },
  { dirName: 'codeindex-app', packageName: 'codeindex-app' },
  { dirName: 'codev-app', packageName: 'codev-app' },
  { dirName: 'nl2sql', packageName: 'nl2sql-engine' },
  { dirName: 'research-app', packageName: 'research-app' },
  { dirName: 'seo-batch', packageName: 'seo-batch' },
  { dirName: 'template-app', packageName: 'template-app' },
  { dirName: 'testman-app', packageName: 'testman-app' },
  { dirName: 'textflow-rag', packageName: 'textflow-rag' },
];

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

/**
 * Collect all .ts and .vue source files under a directory, recursively.
 * Skips: node_modules, dist, __tests__, and any file whose basename
 * ends with .test.ts or .spec.ts — so only production source is scanned.
 */
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
  const source = fs.readFileSync(filePath, 'utf8');
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
      const parts = specifier.split('/');
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

  for (const rule of FORBIDDEN_EDGES) {
    const srcDir = path.join(MONOREPO_ROOT, 'packages', rule.importer, 'src');
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
function extractAppImports(filePath: string, targets: Set<string>): Set<string> {
  const source = fs.readFileSync(filePath, 'utf8');
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
    const parts = specifier.split('/');
    const pkgName = specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
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

/**
 * Scan every app workspace for imports of sibling app packages.
 * Returns one entry per (file, forbidden-package) pair found.
 */
function collectAppViolations(): AppViolation[] {
  if (!fs.existsSync(APPS_ROOT)) {
    // apps/ directory not present (e.g. isolated dzupagent checkout) — skip.
    return [];
  }

  const violations: AppViolation[] = [];

  for (const app of APP_WORKSPACES) {
    const appDir = path.join(APPS_ROOT, app.dirName);
    const files = collectSourceFiles(appDir);

    // Forbidden targets = all OTHER apps' package names
    const forbiddenTargets = new Set(
      APP_WORKSPACES.filter((a) => a.packageName !== app.packageName).map((a) => a.packageName),
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

  return violations;
}

function formatAppViolations(violations: AppViolation[]): string {
  if (violations.length === 0) return '';
  const lines = violations.map(
    (v) =>
      `  FORBIDDEN: ${v.importerPkg} -> ${v.forbiddenPkg}\n  FILE:      apps/${v.file}`,
  );
  return `\nCross-app boundary violations detected:\n\n${lines.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Snapshot of the forbidden-edge rules so that if someone removes an entry
 * from FORBIDDEN_EDGES (accidentally weakening the policy) this test fails.
 */
describe('Architecture boundary rules — policy completeness', () => {
  it('enforces all six declared importer packages', () => {
    const importers = FORBIDDEN_EDGES.map((r) => r.importer).sort();
    expect(importers).toEqual([
      'agent',
      'agent-adapters',
      'codegen',
      'connectors',
      'core',
      'server',
    ]);
  });

  it('core rule forbids all five downstream packages', () => {
    const coreRule = FORBIDDEN_EDGES.find((r) => r.importer === 'core');
    expect(coreRule).toBeDefined();
    expect(coreRule?.forbidden.sort()).toEqual([
      'agent',
      'agent-adapters',
      'codegen',
      'connectors',
      'server',
    ]);
  });

  it('every rule has at least one forbidden target', () => {
    for (const rule of FORBIDDEN_EDGES) {
      expect(
        rule.forbidden.length,
        `Rule for "${rule.importer}" must list at least one forbidden package`,
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * One describe block per package so CI output clearly identifies which
 * package introduced the violation.
 */
describe('Architecture boundary enforcement — @dzupagent/core', () => {
  const violations = collectViolations().filter((v) => v.importer === 'core');

  it('must not import @dzupagent/agent', () => {
    const hits = violations.filter((v) => v.forbidden === 'agent');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });

  it('must not import @dzupagent/codegen', () => {
    const hits = violations.filter((v) => v.forbidden === 'codegen');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });

  it('must not import @dzupagent/connectors', () => {
    const hits = violations.filter((v) => v.forbidden === 'connectors');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });

  it('must not import @dzupagent/server', () => {
    const hits = violations.filter((v) => v.forbidden === 'server');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });

  it('must not import @dzupagent/agent-adapters', () => {
    const hits = violations.filter((v) => v.forbidden === 'agent-adapters');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });
});

describe('Architecture boundary enforcement — @dzupagent/agent', () => {
  const violations = collectViolations().filter((v) => v.importer === 'agent');

  it('must not import @dzupagent/server', () => {
    const hits = violations.filter((v) => v.forbidden === 'server');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });
});

describe('Architecture boundary enforcement — @dzupagent/codegen', () => {
  const violations = collectViolations().filter((v) => v.importer === 'codegen');

  it('must not import @dzupagent/agent', () => {
    const hits = violations.filter((v) => v.forbidden === 'agent');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });

  it('must not import @dzupagent/server', () => {
    const hits = violations.filter((v) => v.forbidden === 'server');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });

  it('must not import @dzupagent/connectors', () => {
    const hits = violations.filter((v) => v.forbidden === 'connectors');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });
});

describe('Architecture boundary enforcement — @dzupagent/connectors', () => {
  const violations = collectViolations().filter((v) => v.importer === 'connectors');

  it('must not import @dzupagent/agent', () => {
    const hits = violations.filter((v) => v.forbidden === 'agent');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });

  it('must not import @dzupagent/codegen', () => {
    const hits = violations.filter((v) => v.forbidden === 'codegen');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });

  it('must not import @dzupagent/server', () => {
    const hits = violations.filter((v) => v.forbidden === 'server');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });
});

describe('Architecture boundary enforcement — @dzupagent/agent-adapters', () => {
  const violations = collectViolations().filter((v) => v.importer === 'agent-adapters');

  it('must not import @dzupagent/server', () => {
    const hits = violations.filter((v) => v.forbidden === 'server');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });
});

describe('Architecture boundary enforcement — @dzupagent/server', () => {
  const violations = collectViolations().filter((v) => v.importer === 'server');

  it('must not import @dzupagent/playground', () => {
    const hits = violations.filter((v) => v.forbidden === 'playground');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });

  it('must not import @dzupagent/create-dzupagent', () => {
    const hits = violations.filter((v) => v.forbidden === 'create-dzupagent');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });

  it('must not import @dzupagent/testing', () => {
    const hits = violations.filter((v) => v.forbidden === 'testing');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });

  it('must not import @dzupagent/test-utils', () => {
    const hits = violations.filter((v) => v.forbidden === 'test-utils');
    expect(hits, formatViolations(hits)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// App-to-app boundary rules — policy completeness
// ---------------------------------------------------------------------------

describe('Apps boundary rules — policy completeness', () => {
  it('enforces all ten declared app workspaces', () => {
    const dirs = APP_WORKSPACES.map((a) => a.dirName).sort();
    expect(dirs).toEqual([
      'ai-saas-starter-kit',
      'blood-pressure',
      'codeindex-app',
      'codev-app',
      'nl2sql',
      'research-app',
      'seo-batch',
      'template-app',
      'testman-app',
      'textflow-rag',
    ]);
  });

  it('every app workspace entry has a non-empty packageName', () => {
    for (const app of APP_WORKSPACES) {
      expect(
        app.packageName.length,
        `APP_WORKSPACES entry for "${app.dirName}" must have a non-empty packageName`,
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
describe('Apps must not import each other', () => {
  const allAppViolations = collectAppViolations();

  for (const app of APP_WORKSPACES) {
    const appViolations = allAppViolations.filter((v) => v.importerDir === app.dirName);

    it(`${app.packageName} must not import any sibling app package`, () => {
      expect(appViolations, formatAppViolations(appViolations)).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Omnibus assertion — single test that reports ALL violations at once
// ---------------------------------------------------------------------------

describe('Architecture boundary enforcement — omnibus', () => {
  it('has zero forbidden cross-package edges across all scanned packages', () => {
    const all = collectViolations();
    expect(all, formatViolations(all)).toHaveLength(0);
  });

  it('has zero forbidden cross-app edges across all scanned app workspaces', () => {
    const all = collectAppViolations();
    expect(all, formatAppViolations(all)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Formatting helper
// ---------------------------------------------------------------------------

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return '';
  const lines = violations.map(
    (v) =>
      `  FORBIDDEN: @dzupagent/${v.importer} -> @dzupagent/${v.forbidden}\n  FILE:      ${v.file}`,
  );
  return `\nBoundary violations detected:\n\n${lines.join('\n\n')}`;
}
