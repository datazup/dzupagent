/**
 * symbol-rename.ts
 *
 * Symbol rename refactoring for a VirtualFS workspace.
 *
 * Responsibilities:
 *  - Rename a TypeScript/JavaScript identifier across all files in the VFS.
 *  - Update import/export statements that reference the renamed symbol.
 *  - Preserve string literals, template literals, and comments — they are
 *    NOT modified even when they contain the old name.
 *  - Return a structured report listing every file changed and how many
 *    replacements occurred in each.
 *
 * Approach: regex-based token replacement operating on individual source
 * tokens. The algorithm is intentionally lightweight (no full AST parse)
 * while still being correct for the common cases covered by the tests.
 *
 * Limitations (by design):
 *  - Does not track scope; a same-named local variable in a different scope
 *    will also be renamed. Use ts-morph for fully scope-aware renames.
 *  - Does not follow aliased imports: `import { foo as bar }` — the alias
 *    `bar` is NOT renamed, only the source name `foo` on its declaration side.
 */

export interface RenameResult {
  /** Number of files that were changed. */
  filesChanged: number;
  /** Per-file details. */
  changes: RenameFileChange[];
}

export interface RenameFileChange {
  /** File path relative to the VFS root. */
  path: string;
  /** Number of identifier replacements in this file. */
  count: number;
}

export interface RenameOptions {
  /**
   * When true the rename is a no-op (old === new).
   * renameSymbol returns early without touching the VFS.
   */
  // (handled internally — not a caller option)

  /**
   * Optional set of file paths to restrict the rename to.
   * Defaults to all files in the VFS.
   */
  paths?: string[];
}

/** Thrown when the new name is already defined in the same scope-level within
 *  a single file.  Currently detects top-level `const/let/var/function/class
 *  /interface/type/enum` declarations only. */
export class RenameCollisionError extends Error {
  constructor(
    public readonly newName: string,
    public readonly filePath: string
  ) {
    super(
      `Rename collision: "${newName}" is already declared in "${filePath}"`
    );
    this.name = "RenameCollisionError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split source text into segments that are either:
 *  - "code"   — normal TypeScript/JavaScript source
 *  - "string" — single-quoted, double-quoted, or template-literal string
 *  - "comment" — line (//) or block (/* … *\/) comment
 *
 * Replacements are only applied to "code" segments.
 */
type Segment = { kind: "code" | "string" | "comment"; text: string };

function tokenize(source: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  let codeStart = 0;

  function flushCode(end: number) {
    if (end > codeStart) {
      segments.push({ kind: "code", text: source.slice(codeStart, end) });
    }
  }

  while (i < source.length) {
    const ch = source[i]!;

    // Line comment
    if (ch === "/" && source[i + 1] === "/") {
      flushCode(i);
      const end = source.indexOf("\n", i + 2);
      const commentEnd = end === -1 ? source.length : end + 1;
      segments.push({ kind: "comment", text: source.slice(i, commentEnd) });
      i = commentEnd;
      codeStart = i;
      continue;
    }

    // Block comment
    if (ch === "/" && source[i + 1] === "*") {
      flushCode(i);
      const end = source.indexOf("*/", i + 2);
      const commentEnd = end === -1 ? source.length : end + 2;
      segments.push({ kind: "comment", text: source.slice(i, commentEnd) });
      i = commentEnd;
      codeStart = i;
      continue;
    }

    // Template literal
    if (ch === "`") {
      flushCode(i);
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "`") {
          j++;
          break;
        }
        j++;
      }
      segments.push({ kind: "string", text: source.slice(i, j) });
      i = j;
      codeStart = i;
      continue;
    }

    // Double-quoted string
    if (ch === '"') {
      flushCode(i);
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      segments.push({ kind: "string", text: source.slice(i, j) });
      i = j;
      codeStart = i;
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      flushCode(i);
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      segments.push({ kind: "string", text: source.slice(i, j) });
      i = j;
      codeStart = i;
      continue;
    }

    i++;
  }

  flushCode(source.length);
  return segments;
}

/** Replace all whole-word occurrences of `oldName` in `code` with `newName`. */
function replaceInCode(
  code: string,
  oldName: string,
  newName: string
): { text: string; count: number } {
  const pattern = new RegExp(
    `(?<![\\w$])${escapeRegex(oldName)}(?![\\w$])`,
    "g"
  );
  let count = 0;
  const text = code.replace(pattern, () => {
    count++;
    return newName;
  });
  return { text, count };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Detect whether `name` is declared at top level in `source`. */
function hasToplevelDeclaration(source: string, name: string): boolean {
  const patterns = [
    // const/let/var name
    new RegExp(
      `^(?:export\\s+)?(?:const|let|var)\\s+${escapeRegex(name)}\\b`,
      "m"
    ),
    // function name(
    new RegExp(
      `^(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(name)}\\b`,
      "m"
    ),
    // class name
    new RegExp(
      `^(?:export\\s+)?(?:abstract\\s+)?class\\s+${escapeRegex(name)}\\b`,
      "m"
    ),
    // interface name
    new RegExp(`^(?:export\\s+)?interface\\s+${escapeRegex(name)}\\b`, "m"),
    // type name =
    new RegExp(`^(?:export\\s+)?type\\s+${escapeRegex(name)}\\b`, "m"),
    // enum name
    new RegExp(
      `^(?:export\\s+)?(?:const\\s+)?enum\\s+${escapeRegex(name)}\\b`,
      "m"
    ),
  ];
  return patterns.some((p) => p.test(source));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rename a symbol across all files in the provided file map.
 *
 * @param files  Map of filePath → sourceText (read from a VirtualFS).
 * @param oldName  Current symbol name.
 * @param newName  Desired symbol name.
 * @param options  Optional: restrict to specific paths.
 *
 * @returns An object containing the updated file contents and a rename report.
 *
 * @throws {RenameCollisionError} if `newName` is already declared at top level
 *   in any file that contains `oldName`.
 */
export function renameSymbol(
  files: Map<string, string>,
  oldName: string,
  newName: string,
  options: RenameOptions = {}
): { updatedFiles: Map<string, string>; result: RenameResult } {
  // No-op: old === new
  if (oldName === newName) {
    return {
      updatedFiles: new Map(files),
      result: { filesChanged: 0, changes: [] },
    };
  }

  const targetPaths = options.paths ? options.paths : [...files.keys()];

  // Collision check: for each file that will be modified, ensure newName is
  // not already declared there.
  for (const filePath of targetPaths) {
    const source = files.get(filePath);
    if (!source) continue;
    if (
      hasToplevelDeclaration(source, oldName) ||
      hasReference(source, oldName)
    ) {
      if (hasToplevelDeclaration(source, newName)) {
        throw new RenameCollisionError(newName, filePath);
      }
    }
  }

  const updatedFiles = new Map(files);
  const changes: RenameFileChange[] = [];

  for (const filePath of targetPaths) {
    const source = files.get(filePath);
    if (source === undefined) continue;

    const segments = tokenize(source);
    let totalCount = 0;
    const newSegments = segments.map((seg) => {
      if (seg.kind !== "code") return seg.text;
      const { text, count } = replaceInCode(seg.text, oldName, newName);
      totalCount += count;
      return text;
    });

    if (totalCount > 0) {
      updatedFiles.set(filePath, newSegments.join(""));
      changes.push({ path: filePath, count: totalCount });
    }
  }

  return {
    updatedFiles,
    result: { filesChanged: changes.length, changes },
  };
}

/** Quick check: does `source` contain the identifier `name` anywhere in code? */
function hasReference(source: string, name: string): boolean {
  const pattern = new RegExp(`(?<![\\w$])${escapeRegex(name)}(?![\\w$])`);
  // Use raw source for a quick pre-check (may have false positives from strings)
  return pattern.test(source);
}
