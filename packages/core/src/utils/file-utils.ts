/**
 * ENOENT-safe filesystem helpers.
 *
 * Centralizes the "read a file, fall back to a default when it does not
 * exist, but rethrow on any other error" pattern so callers stop swallowing
 * genuine IO failures (permissions, malformed JSON surfaced as syntax errors
 * by the parser, disk errors) behind a blanket `catch { return default }`.
 */
import { readFile } from 'node:fs/promises'

/**
 * Minimal structured-logger shape accepted by the file helpers. Every method
 * is optional so callers can pass a partial logger (or omit it entirely).
 */
export interface MinimalLogger {
  debug?: (payload: unknown) => void
  error?: (payload: unknown) => void
}

/** True when an unknown error is a Node ENOENT (file-not-found) error. */
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

export interface ReadFileOrDefaultOptions {
  /** Optional structured logger for debug (ENOENT) / error (other) reporting. */
  logger?: MinimalLogger
  /** File encoding. Defaults to 'utf8'. */
  encoding?: BufferEncoding
}

/**
 * Read a JSON file and parse it, returning {@link defaultValue} when the file
 * does not exist (ENOENT). Any other error (permission denied, malformed
 * JSON, etc.) is logged and rethrown — callers must not silently ignore real
 * failures.
 *
 * @example
 * ```ts
 * const state = await readJsonFileOrDefault(statePath, { items: [] }, { logger })
 * ```
 */
export async function readJsonFileOrDefault<T>(
  path: string,
  defaultValue: T,
  opts?: ReadFileOrDefaultOptions,
): Promise<T> {
  let raw: string
  try {
    raw = await readFile(path, opts?.encoding ?? 'utf8')
  } catch (err) {
    if (isEnoent(err)) {
      opts?.logger?.debug?.({ path, msg: 'file not found, using default' })
      return defaultValue
    }
    opts?.logger?.error?.({ path, err, msg: 'unexpected error reading file' })
    throw err
  }
  // Parse outside the IO try/catch so a JSON syntax error is not mistaken for
  // a missing file and is allowed to propagate.
  return JSON.parse(raw) as T
}

/**
 * Read a file's text contents, returning {@link defaultValue} when the file
 * does not exist (ENOENT). Any other error is logged and rethrown.
 */
export async function readTextFileOrDefault<T = string>(
  path: string,
  defaultValue: T,
  opts?: ReadFileOrDefaultOptions,
): Promise<string | T> {
  try {
    return await readFile(path, opts?.encoding ?? 'utf8')
  } catch (err) {
    if (isEnoent(err)) {
      opts?.logger?.debug?.({ path, msg: 'file not found, using default' })
      return defaultValue
    }
    opts?.logger?.error?.({ path, err, msg: 'unexpected error reading file' })
    throw err
  }
}
