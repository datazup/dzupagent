import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  digestExecutableArtifact,
  validExecutableArtifactDigest,
} from '../introspection/executable-artifact.js'

import {
  CodexAppServerClientError,
  executableInvalid,
  type CodexAppServerClientOptions,
  type CodexAppServerRequestOptions,
} from './codex-app-server-client-contracts.js'
import { normalizeLimits } from './codex-app-server-client-limits.js'
import {
  ensureNotCancelled,
  remainingTimeout,
  tightenedRequestTimeout,
  withinTimeout,
} from './codex-app-server-client-timeouts.js'

/**
 * Re-qualifies a previously resolved Codex executable immediately before use.
 *
 * The identity was resolved at some earlier point, so every field is checked
 * again here against the live filesystem: the symlink target must still resolve
 * to the same real path, the target must still be a regular executable file,
 * and its content digest must still match. Any drift fails closed as
 * `CODEX_APP_SERVER_EXECUTABLE_INVALID` -- this is the time-of-check/time-of-use
 * boundary for spawning a third-party binary, not a convenience validation.
 */
export async function qualifyCodexAppServerExecutable(
  options: CodexAppServerClientOptions,
  requestOptions: CodexAppServerRequestOptions = {},
): Promise<string> {
  const limits = normalizeLimits(options.limits)
  const monotonicNow = options.dependencies?.monotonicNow ?? (() => performance.now())
  const deadline = monotonicNow()
    + tightenedRequestTimeout(limits.requestTimeoutMs, requestOptions.timeoutMs)
  return qualifyExecutable(options, deadline, monotonicNow, requestOptions.signal)
}

export async function qualifyExecutable(
  options: CodexAppServerClientOptions,
  deadline: number,
  monotonicNow: () => number,
  signal?: AbortSignal,
): Promise<string> {
  ensureNotCancelled(signal)
  const identity = options.executable
  if (
    !identity
    || identity.name !== 'codex'
    || !isAbsolute(identity.path)
    || !isAbsolute(identity.realPath)
    || !validExecutableArtifactDigest(identity.artifactDigest)
  ) throw executableInvalid()

  const resolveRealPath = options.dependencies?.realpath ?? realpath
  const inspectStat = options.dependencies?.stat ?? stat
  const checkAccess = options.dependencies?.access ?? access
  let actualRealPath: string
  try {
    actualRealPath = await withinTimeout(
      resolveRealPath(identity.path),
      remainingTimeout(deadline, monotonicNow),
      signal,
    )
  } catch (error) {
    // A timeout or cancellation is a control-flow outcome and keeps its own
    // code; anything else collapses to "invalid" so a filesystem error string
    // cannot leak the probed path back to the caller.
    if (error instanceof CodexAppServerClientError && (
      error.code === 'CODEX_APP_SERVER_TIMEOUT'
      || error.code === 'CODEX_APP_SERVER_CANCELLED'
    )) {
      throw error
    }
    throw executableInvalid()
  }
  if (actualRealPath !== identity.realPath) throw executableInvalid()

  try {
    const executableStat = await withinTimeout(
      inspectStat(actualRealPath),
      remainingTimeout(deadline, monotonicNow),
      signal,
    )
    if (!executableStat.isFile()) throw executableInvalid()
  } catch (error) {
    if (error instanceof CodexAppServerClientError) throw error
    throw executableInvalid()
  }

  try {
    await withinTimeout(
      checkAccess(actualRealPath, constants.X_OK),
      remainingTimeout(deadline, monotonicNow),
      signal,
    )
  } catch (error) {
    if (error instanceof CodexAppServerClientError && (
      error.code === 'CODEX_APP_SERVER_TIMEOUT'
      || error.code === 'CODEX_APP_SERVER_CANCELLED'
    )) {
      throw error
    }
    throw executableInvalid()
  }
  await qualifyArtifactDigest(options, actualRealPath, deadline, monotonicNow, signal)
  ensureNotCancelled(signal)
  remainingTimeout(deadline, monotonicNow)
  return actualRealPath
}

export async function qualifyArtifactDigest(
  options: CodexAppServerClientOptions,
  executablePath: string,
  deadline: number,
  monotonicNow: () => number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const digestArtifact = options.dependencies?.digestArtifact ?? digestExecutableArtifact
    const actualDigest = await withinTimeout(
      digestArtifact(executablePath),
      remainingTimeout(deadline, monotonicNow),
      signal,
    )
    if (actualDigest !== options.executable.artifactDigest) throw executableInvalid()
  } catch (error) {
    if (error instanceof CodexAppServerClientError) throw error
    throw executableInvalid()
  }
}
