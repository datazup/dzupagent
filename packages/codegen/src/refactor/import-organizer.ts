/**
 * import-organizer.ts
 *
 * Import organization refactoring for TypeScript/JavaScript source files.
 *
 * Responsibilities:
 *  - Parse all import declarations from a source file.
 *  - Group imports into three categories: external (npm), internal (@scope/pkg),
 *    and relative (./foo, ../bar).
 *  - Sort each group alphabetically by module specifier.
 *  - Sort named imports within each `{ }` clause alphabetically.
 *  - Separate groups with a single blank line.
 *  - Remove imports whose bindings are not referenced in the file body
 *    (side-effect imports `import './foo'` are always preserved).
 *  - Handle default, namespace, named, and combined imports.
 *  - `import type { ... }` declarations are preserved as-is and grouped with
 *    their specifier category.
 *
 * Approach: regex-based — no full AST parse required. Intentionally
 * lightweight while covering the common cases tested in the suite.
 */

export interface ImportGroup {
  external: ParsedImport[];
  internal: ParsedImport[];
  relative: ParsedImport[];
}

export interface ParsedImport {
  /** The full original import statement text (single line). */
  raw: string;
  /** Module specifier, e.g. "react", "@scope/pkg", "./utils". */
  specifier: string;
  /** Whether this is a side-effect import (`import './foo'`). */
  isSideEffect: boolean;
  /** Whether this is a type-only import (`import type ...`). */
  isTypeOnly: boolean;
  /** Default import binding, if any. */
  defaultBinding: string | null;
  /** Namespace import binding, if any (`import * as ns`). */
  namespaceBinding: string | null;
  /** Named bindings `{ A, B as C }`. */
  namedBindings: string[];
}

export interface OrganizeResult {
  /** Re-organized source code. */
  code: string;
  /** Whether the file was changed. */
  changed: boolean;
  /** Imports that were removed as unused. */
  removed: string[];
}

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

/**
 * Matches a full single-line import statement.
 * Groups:
 *   1 — optional `type ` keyword
 *   2 — everything between `import` and `from` (bindings)
 *   3 — module specifier (without quotes)
 */
/* eslint-disable security/detect-unsafe-regex --
 * Bounded import grammar over a single source line; not used with untrusted patterns.
 */
const IMPORT_RE =
  /^import\s+(type\s+)?({[^}]*}|\*\s+as\s+\w+|\w+(?:\s*,\s*{[^}]*})?|['"][^'"]*['"])\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;
/* eslint-enable security/detect-unsafe-regex */

/** Matches a side-effect import: `import './foo'` or `import "foo"` */
const SIDE_EFFECT_RE = /^import\s+['"]([^'"]+)['"]\s*;?\s*$/;

/** Matches `import type { ... } from '...'` specifically */
const IMPORT_TYPE_RE = /^import\s+type\s+/;

/**
 * Detect whether `name` is referenced as a value/type in `body` (text after
 * all import declarations).
 *
 * We look for the name as a whole word. Template literals, comments, and
 * string literals may produce false positives — this is acceptable for a
 * lightweight organizer.
 */
function isReferenced(name: string, body: string): boolean {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  return re.test(body);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseImport(line: string): ParsedImport | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("import")) return null;

  const isSideEffect = SIDE_EFFECT_RE.test(trimmed);
  if (isSideEffect) {
    const m = SIDE_EFFECT_RE.exec(trimmed)!;
    return {
      raw: line,
      specifier: m[1]!,
      isSideEffect: true,
      isTypeOnly: false,
      defaultBinding: null,
      namespaceBinding: null,
      namedBindings: [],
    };
  }

  const isTypeOnly = IMPORT_TYPE_RE.test(trimmed);

  const m = IMPORT_RE.exec(trimmed);
  if (!m) return null;

  const bindings = m[2]!.trim();
  const specifier = m[3]!;

  let defaultBinding: string | null = null;
  let namespaceBinding: string | null = null;
  let namedBindings: string[] = [];

  if (bindings.startsWith("*")) {
    // `* as ns`
    const nsMatch = /\*\s+as\s+(\w+)/.exec(bindings);
    if (nsMatch) namespaceBinding = nsMatch[1]!;
  } else if (bindings.startsWith("{")) {
    // `{ A, B as C }`
    namedBindings = parseNamedBindings(bindings);
  } else if (bindings.includes("{")) {
    // `Default, { A, B }`
    const commaIdx = bindings.indexOf(",");
    defaultBinding = bindings.slice(0, commaIdx).trim();
    const bracesPart = bindings.slice(commaIdx + 1).trim();
    namedBindings = parseNamedBindings(bracesPart);
  } else {
    // plain default import
    defaultBinding = bindings.trim();
  }

  return {
    raw: line,
    specifier,
    isSideEffect: false,
    isTypeOnly,
    defaultBinding,
    namespaceBinding,
    namedBindings,
  };
}

function parseNamedBindings(braces: string): string[] {
  const inner = braces.replace(/^\{/, "").replace(/\}$/, "").trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function classifySpecifier(
  specifier: string
): "external" | "internal" | "relative" {
  if (specifier.startsWith(".")) return "relative";
  if (specifier.startsWith("@")) return "internal";
  return "external";
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortNamedBindings(bindings: string[]): string[] {
  return [...bindings].sort((a, b) => {
    // Sort by the local name (handle `Foo as bar` — compare by `Foo`)
    const localA = a.split(/\s+as\s+/)[0]!.trim();
    const localB = b.split(/\s+as\s+/)[0]!.trim();
    return localA.localeCompare(localB);
  });
}

function rebuildImportLine(imp: ParsedImport): string {
  if (imp.isSideEffect) return imp.raw.trimEnd();

  const typePrefix = imp.isTypeOnly ? "type " : "";

  let bindings: string;
  if (imp.namespaceBinding) {
    bindings = `* as ${imp.namespaceBinding}`;
  } else if (imp.defaultBinding && imp.namedBindings.length > 0) {
    const sorted = sortNamedBindings(imp.namedBindings);
    bindings = `${imp.defaultBinding}, { ${sorted.join(", ")} }`;
  } else if (imp.namedBindings.length > 0) {
    const sorted = sortNamedBindings(imp.namedBindings);
    bindings = `{ ${sorted.join(", ")} }`;
  } else if (imp.defaultBinding) {
    bindings = imp.defaultBinding;
  } else {
    bindings = "";
  }

  return `import ${typePrefix}${bindings} from '${imp.specifier}'`;
}

// ---------------------------------------------------------------------------
// Unused-import removal
// ---------------------------------------------------------------------------

/**
 * Given a parsed import and the file body (everything after imports), return
 * a filtered ParsedImport with unused bindings removed, or null if the entire
 * import is unused.
 */
function pruneUnused(imp: ParsedImport, body: string): ParsedImport | null {
  // Side-effect imports are always kept.
  if (imp.isSideEffect) return imp;

  // Type-only imports (`import type { ... }`) are erased at compile time;
  // the imported names may not appear as value references in the body.
  // Always preserve them so we don't break TypeScript compilation.
  if (imp.isTypeOnly) return imp;

  const isUsed = (name: string) => isReferenced(name, body);

  const prunedNamed = imp.namedBindings.filter((binding) => {
    // For `Foo as bar`, check `bar` (local alias) in the body.
    const parts = binding.split(/\s+as\s+/);
    const localName = parts.length > 1 ? parts[1]!.trim() : parts[0]!.trim();
    return isUsed(localName);
  });

  const defaultUsed = imp.defaultBinding ? isUsed(imp.defaultBinding) : false;
  const namespaceUsed = imp.namespaceBinding
    ? isUsed(imp.namespaceBinding)
    : false;

  // If nothing is used, drop the import entirely.
  if (!defaultUsed && !namespaceUsed && prunedNamed.length === 0) return null;

  return {
    ...imp,
    defaultBinding: defaultUsed ? imp.defaultBinding : null,
    namespaceBinding: namespaceUsed ? imp.namespaceBinding : null,
    namedBindings: prunedNamed,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OrganizeOptions {
  /** When true, remove unused imports. Default: true. */
  removeUnused?: boolean;
}

/**
 * Organize imports in a single TypeScript/JavaScript source file.
 *
 * @param source  Full file content.
 * @param options Optional configuration.
 * @returns       OrganizeResult with re-written code, change flag, and list
 *                of removed import specifiers.
 */
export function organizeImports(
  source: string,
  options: OrganizeOptions = {}
): OrganizeResult {
  const removeUnused = options.removeUnused !== false;

  const lines = source.split("\n");
  const importLines: string[] = [];
  let firstNonImportIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    // Collect consecutive import lines (skip blank lines between imports too)
    if (trimmed === "" && firstNonImportIdx === -1) {
      // Allow blank lines before imports start
      continue;
    }
    if (trimmed.startsWith("import")) {
      importLines.push(trimmed);
    } else {
      firstNonImportIdx = i;
      break;
    }
  }

  // Body = everything after import block
  const bodyLines =
    firstNonImportIdx >= 0 ? lines.slice(firstNonImportIdx) : [];
  const body = bodyLines.join("\n");

  const parsed: ParsedImport[] = [];
  const unparseable: string[] = [];

  for (const line of importLines) {
    const p = parseImport(line);
    if (p) {
      parsed.push(p);
    } else if (line.trim()) {
      unparseable.push(line);
    }
  }

  // Prune unused
  const removed: string[] = [];
  const kept: ParsedImport[] = [];

  for (const imp of parsed) {
    if (removeUnused) {
      const pruned = pruneUnused(imp, body);
      if (!pruned) {
        removed.push(imp.specifier);
      } else {
        // Check if any named bindings were removed
        const removedNamed = imp.namedBindings.filter(
          (nb) => !pruned.namedBindings.includes(nb)
        );
        if (
          removedNamed.length > 0 ||
          pruned.defaultBinding !== imp.defaultBinding
        ) {
          // partial prune — mark specifier with a note but keep it
        }
        kept.push(pruned);
      }
    } else {
      kept.push(imp);
    }
  }

  // Group
  const external: ParsedImport[] = [];
  const internal: ParsedImport[] = [];
  const relative: ParsedImport[] = [];

  for (const imp of kept) {
    const group = classifySpecifier(imp.specifier);
    if (group === "external") external.push(imp);
    else if (group === "internal") internal.push(imp);
    else relative.push(imp);
  }

  // Sort each group by specifier
  const sortGroup = (g: ParsedImport[]) =>
    g.sort((a, b) => a.specifier.localeCompare(b.specifier));

  sortGroup(external);
  sortGroup(internal);
  sortGroup(relative);

  // Build output lines
  const outputImportLines: string[] = [];
  const groups = [external, internal, relative];

  for (const group of groups) {
    if (group.length === 0) continue;
    if (outputImportLines.length > 0) outputImportLines.push("");
    for (const imp of group) {
      outputImportLines.push(rebuildImportLine(imp));
    }
  }

  // Add unparseable lines at the end of imports (preserve them)
  if (unparseable.length > 0) {
    if (outputImportLines.length > 0) outputImportLines.push("");
    outputImportLines.push(...unparseable);
  }

  // Reconstruct file
  const bodyStr = body.startsWith("\n")
    ? body
    : body.length > 0
    ? "\n" + body
    : "";

  let newSource: string;
  if (outputImportLines.length > 0) {
    newSource = outputImportLines.join("\n") + bodyStr;
  } else if (body.length > 0) {
    // All imports were removed — return just the body (strip leading newline)
    newSource = body.startsWith("\n") ? body.slice(1) : body;
  } else {
    // No imports and no body — return the original (empty or comment-only file)
    newSource = source;
  }

  const changed = newSource !== source;

  return { code: newSource, changed, removed };
}

/**
 * Organize imports for all TS/JS files in a VFS-like map.
 */
export function organizeImportsInMap(
  files: Map<string, string>,
  options?: OrganizeOptions
): Map<string, string> {
  const result = new Map(files);
  const TS_JS = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

  for (const [path, content] of files) {
    if (!TS_JS.test(path)) continue;
    const { code } = organizeImports(content, options);
    result.set(path, code);
  }

  return result;
}
