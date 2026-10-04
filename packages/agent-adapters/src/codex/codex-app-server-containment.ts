import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

import type {
  CodexAppServerContainment,
  CodexAppServerJoinReceipt,
} from './codex-app-server-client-contracts.js'

export interface CodexContainedCommand {
  readonly command: string
  readonly args: readonly string[]
  /** sha256 of the exact argv, so a receipt names the sandbox that produced it. */
  readonly argvDigest: string
}

function assertWritablePath(path: string): void {
  if (!isAbsolute(path) || path === '/' || path.includes('\0')) {
    throw new TypeError('Codex containment writable paths must be absolute, non-root paths')
  }
}

/**
 * Wraps the app-server argv in a bubblewrap PID namespace. The namespace's
 * init is the only task the outer process waits for, so when the outer process
 * exits on its own the kernel has already killed and reaped every descendant.
 * The root is read-only; only `writablePaths` accept writes. Network is NOT
 * isolated, so remote effects are outside what a join receipt covers.
 */
export function buildCodexContainedCommand(
  containment: CodexAppServerContainment,
  executablePath: string,
  appArgs: readonly string[],
): CodexContainedCommand {
  for (const path of containment.writablePaths) assertWritablePath(path)
  const command = containment.bwrapPath ?? 'bwrap'
  const args = [
    '--unshare-pid',
    '--die-with-parent',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    ...containment.writablePaths.flatMap(path => ['--bind', path, path]),
    '--',
    executablePath,
    ...appArgs,
  ]
  const argvDigest = `sha256:${createHash('sha256').update(JSON.stringify([command, ...args])).digest('hex')}`
  return { command, args, argvDigest }
}

/**
 * `joined` is true only when the outer process has exited by itself. A signal
 * death of the outer process proves nothing about its descendants, so it is
 * reported as not joined rather than inferred.
 */
export function codexJoinReceipt(
  argvDigest: string,
  status: { readonly code: number | null, readonly signal: NodeJS.Signals | null } | undefined,
): CodexAppServerJoinReceipt {
  return {
    joined: status !== undefined && status.signal === null,
    exitCode: status?.code ?? null,
    signal: status?.signal ?? null,
    argvDigest,
  }
}
