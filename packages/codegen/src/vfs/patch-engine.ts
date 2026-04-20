/**
 * Unified diff/patch engine for the codegen VFS system.
 *
 * Parses unified diff format, applies hunks with context matching,
 * reports per-hunk success/failure, and supports transactional
 * rollback via injected file I/O callbacks.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Typed error codes for patch operations */
export type PatchErrorCode =
  | 'E_PARSE'            // Malformed diff format
  | 'E_CONTEXT_MISMATCH' // Context lines don't match file content
  | 'E_FILE_NOT_FOUND'   // Target file doesn't exist
  | 'E_HUNK_CONFLICT'    // Hunk can't be applied at expected location
  | 'E_ALREADY_APPLIED'  // Hunk content already matches (idempotent)

export interface PatchLine {
  type: 'context' | 'add' | 'remove'
  content: string
}

export interface PatchHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: PatchLine[]
}

export interface FilePatch {
  oldPath: string
  newPath: string
  hunks: PatchHunk[]
}

export interface HunkResult {
  hunkIndex: number
  applied: boolean
  error?: PatchErrorCode
  message?: string
  /** Line number where hunk was applied (may differ from expected due to offset) */
  appliedAtLine?: number
}

export interface PatchApplyResult {
  success: boolean
  filePath: string
  hunkResults: HunkResult[]
  /** Updated file content (if any hunks applied) */
  content?: string
  /** Overall error if the entire patch failed */
  error?: PatchErrorCode
  errorMessage?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip the a/ or b/ prefix from diff paths. */
function stripPathPrefix(raw: string): string {
  return raw.replace(/^[ab]\//, '')
}

/** Parse a hunk header like @@ -10,7 +10,8 @@ optional text */
const HUNK_HEADER_RE = /^@@\s-(\d+),?(\d*)\s\+(\d+),?(\d*)\s@@/

function parseHunkHeader(line: string): Pick<PatchHunk, 'oldStart' | 'oldCount' | 'newStart' | 'newCount'> | null {
  const m = HUNK_HEADER_RE.exec(line)
  if (!m) return null
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] ? Number(m[2]) : 1,
    newStart: Number(m[3]),
    newCount: m[4] ? Number(m[4]) : 1,
  }
}

// ---------------------------------------------------------------------------
// parseUnifiedDiff
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff string into structured FilePatch objects.
 */
export function parseUnifiedDiff(diff: string): FilePatch[] {
  const lines = diff.split('\n')
  const patches: FilePatch[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // Look for --- line (start of a file patch)
    if (line.startsWith('--- ')) {
      const oldPath = stripPathPrefix(line.slice(4).trim())
      i++

      // Expect +++ line next
      if (i >= lines.length || !lines[i]!.startsWith('+++ ')) {
        throw new PatchParseError('Expected +++ line after --- line')
      }
      const newPath = stripPathPrefix(lines[i]!.slice(4).trim())
      i++

      const hunks: PatchHunk[] = []

      // Parse all hunks for this file
      while (i < lines.length && lines[i]!.startsWith('@@')) {
        const header = parseHunkHeader(lines[i]!)
        if (!header) {
          throw new PatchParseError(`Malformed hunk header: ${lines[i]}`)
        }
        i++

        const hunkLines: PatchLine[] = []
        // Determine how many old/new lines this hunk should consume.
        // Using explicit counts from the hunk header prevents the loop
        // from greedily swallowing the next file's `--- a/...` / `+++ b/...`
        // headers as remove/add lines in multi-file diffs.
        let oldRemaining = header.oldCount
        let newRemaining = header.newCount
        while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
          const hLine = lines[i]!
          // Guard: if we see a new file-header or diff-git boundary before
          // the expected line counts are exhausted, stop consuming this hunk.
          if (
            hLine.startsWith('--- ') ||
            hLine.startsWith('+++ ') ||
            hLine.startsWith('diff --git') ||
            hLine.startsWith('@@')
          ) {
            break
          }
          if (hLine.startsWith(' ')) {
            hunkLines.push({ type: 'context', content: hLine.slice(1) })
            oldRemaining--
            newRemaining--
            i++
          } else if (hLine.startsWith('+')) {
            hunkLines.push({ type: 'add', content: hLine.slice(1) })
            newRemaining--
            i++
          } else if (hLine.startsWith('-')) {
            hunkLines.push({ type: 'remove', content: hLine.slice(1) })
            oldRemaining--
            i++
          } else if (hLine.startsWith('\\')) {
            // "\ No newline at end of file" — skip
            i++
          } else {
            // Unknown line type — end of hunk body
            break
          }
        }

        hunks.push({ ...header, lines: hunkLines })
      }

      patches.push({ oldPath, newPath, hunks })
    } else {
      // Skip non-diff lines (e.g. "diff --git", "index ...", etc.)
      i++
    }
  }

  if (patches.length === 0 && diff.trim().length > 0) {
    throw new PatchParseError('No file patches found in diff')
  }

  return patches
}

/** Error subclass thrown by parseUnifiedDiff for malformed input. */
export class PatchParseError extends Error {
  readonly code: PatchErrorCode = 'E_PARSE'
  constructor(message: string) {
    super(message)
    this.name = 'PatchParseError'
  }
}

// ---------------------------------------------------------------------------
// applyPatch
// ---------------------------------------------------------------------------

/**
 * Check whether a hunk's expected "new" content already exists at a given
 * position in the file, meaning the hunk was already applied.
 */
function isAlreadyApplied(fileLines: string[], hunk: PatchHunk, startLine: number): boolean {
  const newLines = hunk.lines
    .filter((l) => l.type === 'context' || l.type === 'add')
    .map((l) => l.content)

  if (startLine + newLines.length > fileLines.length) return false

  return newLines.every((expected, idx) => fileLines[startLine + idx] === expected)
}

/**
 * Try to match the context/remove lines of a hunk against the file at
 * a given starting line (0-based). Returns true if all context and
 * remove lines match.
 */
function contextMatches(fileLines: string[], hunk: PatchHunk, startLine: number): boolean {
  const expectedLines = hunk.lines.filter((l) => l.type === 'context' || l.type === 'remove')
  if (startLine + expectedLines.length > fileLines.length) return false

  let fileIdx = startLine
  for (const pl of hunk.lines) {
    if (pl.type === 'add') continue
    if (fileIdx >= fileLines.length) return false
    if (fileLines[fileIdx] !== pl.content) return false
    fileIdx++
  }
  return true
}

/**
 * Find the best line to apply a hunk, trying exact position first then
 * searching within a fuzz window of ±maxFuzz lines.
 */
function findHunkPosition(
  fileLines: string[],
  hunk: PatchHunk,
  offset: number,
  maxFuzz: number,
): number | null {
  const idealLine = hunk.oldStart - 1 + offset // 0-based

  // Try exact position first
  if (contextMatches(fileLines, hunk, idealLine)) return idealLine

  // Try fuzz positions
  for (let delta = 1; delta <= maxFuzz; delta++) {
    if (idealLine - delta >= 0 && contextMatches(fileLines, hunk, idealLine - delta)) {
      return idealLine - delta
    }
    if (contextMatches(fileLines, hunk, idealLine + delta)) {
      return idealLine + delta
    }
  }

  return null
}

/**
 * Apply a single hunk to the file lines array in-place, returning the
 * number of lines added (positive) or removed (negative) as a net offset.
 */
function applySingleHunk(fileLines: string[], hunk: PatchHunk, startLine: number): number {
  let fileIdx = startLine
  const toInsert: string[] = []
  let removals = 0

  for (const pl of hunk.lines) {
    switch (pl.type) {
      case 'context':
        // Advance past context line
        fileIdx++
        break
      case 'remove':
        removals++
        fileIdx++
        break
      case 'add':
        toInsert.push(pl.content)
        break
    }
  }

  // Splice: remove old lines, insert new lines
  const removeCount = hunk.lines.filter((l) => l.type === 'context' || l.type === 'remove').length
  const newContent = hunk.lines
    .filter((l) => l.type === 'context' || l.type === 'add')
    .map((l) => l.content)

  fileLines.splice(startLine, removeCount, ...newContent)

  return newContent.length - removeCount
}

const MAX_FUZZ = 3

/**
 * Apply a parsed FilePatch to file content.
 * Returns per-hunk results and the updated content.
 */
export function applyPatch(content: string, patch: FilePatch): PatchApplyResult {
  const filePath = patch.newPath || patch.oldPath
  const fileLines = content.split('\n')
  const hunkResults: HunkResult[] = []
  let offset = 0
  let anyApplied = false
  let anyFailed = false

  for (let hi = 0; hi < patch.hunks.length; hi++) {
    const hunk = patch.hunks[hi]!

    // Check if already applied at the expected new position
    const alreadyPos = hunk.newStart - 1 + offset
    if (isAlreadyApplied(fileLines, hunk, alreadyPos >= 0 ? alreadyPos : 0)) {
      hunkResults.push({
        hunkIndex: hi,
        applied: false,
        error: 'E_ALREADY_APPLIED',
        message: 'Hunk content already matches — patch was already applied',
      })
      continue
    }

    const pos = findHunkPosition(fileLines, hunk, offset, MAX_FUZZ)
    if (pos === null) {
      // Determine whether it's a context mismatch or conflict
      const expectedLines = hunk.lines.filter((l) => l.type === 'context' || l.type === 'remove')
      const idealLine = hunk.oldStart - 1 + offset
      const hasContextIssue =
        idealLine >= 0 &&
        idealLine < fileLines.length &&
        expectedLines.length > 0 &&
        expectedLines.some((l, idx) => {
          const fl = fileLines[idealLine + idx]
          return fl !== undefined && fl !== l.content
        })

      const errorCode: PatchErrorCode = hasContextIssue ? 'E_CONTEXT_MISMATCH' : 'E_HUNK_CONFLICT'
      hunkResults.push({
        hunkIndex: hi,
        applied: false,
        error: errorCode,
        message: `Could not apply hunk ${hi} at line ${hunk.oldStart + offset}`,
      })
      anyFailed = true
      continue
    }

    const delta = applySingleHunk(fileLines, hunk, pos)
    offset += delta
    anyApplied = true
    hunkResults.push({
      hunkIndex: hi,
      applied: true,
      appliedAtLine: pos + 1, // 1-based for user consumption
    })
  }

  const result: PatchApplyResult = {
    success: anyApplied && !anyFailed,
    filePath,
    hunkResults,
  }

  if (anyApplied) {
    result.content = fileLines.join('\n')
  }

  if (anyFailed && !anyApplied) {
    result.error = 'E_HUNK_CONFLICT'
    result.errorMessage = 'All hunks failed to apply'
  }

  return result
}

// ---------------------------------------------------------------------------
// applyPatchSet
// ---------------------------------------------------------------------------

export interface ApplyPatchSetOptions {
  rollbackOnFailure?: boolean
}

/**
 * Apply multiple file patches with rollback support.
 * Uses snapshots of original file content for atomic all-or-nothing application.
 */
export async function applyPatchSet(
  patches: FilePatch[],
  readFile: (path: string) => Promise<string | null>,
  writeFile: (path: string, content: string) => Promise<void>,
  options?: ApplyPatchSetOptions,
): Promise<{ results: PatchApplyResult[]; rolledBack: boolean }> {
  const rollbackOnFailure = options?.rollbackOnFailure ?? false
  const results: PatchApplyResult[] = []
  // Track original content for rollback
  const originals = new Map<string, string>()
  const writtenPaths: string[] = []
  let hasFailure = false

  for (const patch of patches) {
    const filePath = patch.newPath || patch.oldPath
    const content = await readFile(filePath)

    if (content === null) {
      // For add-only patches (new files), start with empty content
      const hasOnlyAdds = patch.hunks.every((h) =>
        h.lines.every((l) => l.type === 'add'),
      )
      if (!hasOnlyAdds) {
        results.push({
          success: false,
          filePath,
          hunkResults: [],
          error: 'E_FILE_NOT_FOUND',
          errorMessage: `File not found: ${filePath}`,
        })
        hasFailure = true
        if (rollbackOnFailure) break
        continue
      }
      // New file — apply with empty content
      originals.set(filePath, '')
      const patchResult = applyPatch('', patch)
      results.push(patchResult)
      if (patchResult.content !== undefined) {
        await writeFile(filePath, patchResult.content)
        writtenPaths.push(filePath)
      }
      if (!patchResult.success) {
        hasFailure = true
        if (rollbackOnFailure) break
      }
      continue
    }

    originals.set(filePath, content)
    const patchResult = applyPatch(content, patch)
    results.push(patchResult)

    if (patchResult.content !== undefined) {
      await writeFile(filePath, patchResult.content)
      writtenPaths.push(filePath)
    }

    if (!patchResult.success) {
      hasFailure = true
      if (rollbackOnFailure) break
    }
  }

  // Rollback if requested and there was a failure
  if (hasFailure && rollbackOnFailure) {
    for (const path of writtenPaths) {
      const original = originals.get(path)
      if (original !== undefined) {
        await writeFile(path, original)
      }
    }
    return { results, rolledBack: true }
  }

  return { results, rolledBack: false }
}
