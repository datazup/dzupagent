/**
 * Shared ripgrep probe and invocation for the repository gate scripts
 * (DZUPAGENT-ARCH-L-08).
 *
 * Fallback policy: `rg` is not guaranteed to be installed on every host the
 * gates run on. A gate must call `isRipgrepAvailable()` before `runRipgrep()`
 * and, when it returns false, perform an equivalent pure-Node scan instead of
 * crashing with `spawnSync rg ENOENT`. `warnRipgrepFallback()` emits the single
 * stderr notice a gate prints when it takes that fallback. This module is the
 * only place in scripts/ that spawns `rg`.
 */
import { execFileSync } from 'node:child_process'

let cachedAvailability = null

/**
 * Probe for the `rg` binary once per process. The result is cached; pass
 * `{ refresh: true }` to probe again (tests that alter PATH).
 */
export function isRipgrepAvailable({ refresh = false } = {}) {
  if (cachedAvailability !== null && !refresh) return cachedAvailability
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' })
    cachedAvailability = true
  } catch {
    cachedAvailability = false
  }
  return cachedAvailability
}

/**
 * Run ripgrep and return its stdout. Exit status 1 (no matches) is success
 * and yields an empty string; any other failure is rethrown.
 */
export function runRipgrep(args, { cwd = process.cwd() } = {}) {
  try {
    return execFileSync('rg', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      return ''
    }
    throw error
  }
}

/**
 * Run ripgrep and return its non-empty output lines.
 */
export function runRipgrepLines(args, options) {
  return runRipgrep(args, options).trim().split('\n').map((line) => line.trim()).filter(Boolean)
}

/**
 * Print the standard notice for a gate that is taking its pure-Node fallback.
 */
export function warnRipgrepFallback(gateName, detail = 'falling back to a pure-Node source scan.') {
  console.warn(`[${gateName}] \`rg\` (ripgrep) is not installed on this host; ${detail}`)
}
