/**
 * DZUPAGENT-ERR-L-05 — shared "missing file vs corrupt file" discipline for the
 * .dzupagent loaders.
 *
 * The loaders (`agent-loader`, `memory-loader`, `file-loader`) all read a file,
 * parse/validate it, and cache the result. Their `loadFileCached` helpers
 * historically caught EVERY throw and returned `undefined` with the comment
 * "file disappeared or unreadable -- skip silently". That made a genuinely
 * absent file (ENOENT — expected, benign) indistinguishable from a malformed or
 * invalid agent/skill/memory definition (a parse/validation throw — a real
 * operator-facing defect that was being silently dropped).
 *
 * Mirrors `@dzupagent/core`'s `readTextFileOrDefault`/`readJsonFileOrDefault`
 * pattern: ENOENT-class "genuinely missing file" errors are skipped quietly,
 * while anything else (permission denied, malformed frontmatter, failed schema
 * validation, disk error) is logged at WARN through the framework logger so a
 * corrupt config surfaces instead of vanishing. Callers still treat the entry
 * as "skip" in both cases, preserving the resilient load-what-you-can behaviour.
 */
import { defaultLogger } from "@dzupagent/core/utils";

/** True when an unknown error is a Node ENOENT (file-not-found) error. */
export function isFileMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  // ENOENT: path does not exist. ENOTDIR: a path component is not a directory
  // (e.g. the .dzupagent dir was replaced by a file) — also "not really there".
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Classify a load failure. Returns silently (skip) when the file is genuinely
 * absent; otherwise logs a warning so a malformed/unreadable definition is
 * observable rather than indistinguishable from "no file".
 *
 * @param loader  short label for the loader (e.g. `'agent-loader'`)
 * @param filePath  path being loaded, for log context
 * @param err  the caught error
 */
export function reportLoaderFileError(
  loader: string,
  filePath: string,
  err: unknown
): void {
  if (isFileMissingError(err)) return; // benign: file absent — skip silently
  defaultLogger.warn(
    `[${loader}] failed to load "${filePath}" — skipping (definition is unreadable or invalid, not merely absent)`,
    { error: err instanceof Error ? err.message : String(err) }
  );
}
