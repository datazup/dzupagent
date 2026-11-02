import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClineBinding, ClineParentMessage } from './cline-worker-protocol.js'
import { boundedFrame, CLINE_LIMITS } from './cline-worker-protocol.js'

export interface ClineTransport {
  send(message: ClineParentMessage): Promise<void>
  shutdown(): Promise<void>
}
export type ClineTransportFactory = (
  binding: ClineBinding,
  onMessage: (message: unknown) => void,
  onFailure: (code: string) => void,
) => Promise<ClineTransport>

/** Never spread process.env. In particular NODE_OPTIONS, proxies, auth and CLINE_* stay out. */
export function clineChildEnv(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (source[key]) result[key] = source[key]
  return { ...result, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), TMPDIR: join(home, 'tmp'),
    TMP: join(home, 'tmp'), TEMP: join(home, 'tmp') }
}

export async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([promise.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })]) }
  finally { if (timer) clearTimeout(timer) }
}

/** P06 must emit this relative worker entry and qualify it from the packed artifact. */
export const createClineTransport: ClineTransportFactory = async (binding, onMessage, onFailure) => {
  if (process.platform === 'win32') throw new Error('CLINE_PROCESS_GROUP_UNSUPPORTED')
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('CLINE_NODE_22_REQUIRED')
  const home = await mkdtemp(join(tmpdir(), 'dzup-cline-'))
  try {
    for (const name of ['config', 'cache', 'data', 'state', 'tmp']) await mkdir(join(home, name), { mode: 0o700 })
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cline-worker.js', import.meta.url)),
      '--dzup-cline-worker', binding.runId, binding.sessionId, home], {
      detached: true, env: clineChildEnv(process.env, home), cwd: home,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json',
    })
    let closed = false
    let shuttingDown = false
    let pendingSends = 0
    let outputBytes = 0
    let shutdownPromise: Promise<void> | undefined
    let resolveClosed!: () => void
    const closePromise = new Promise<void>(resolve => { resolveClosed = resolve })
    child.on('message', onMessage)
    child.on('error', () => { if (!shuttingDown) onFailure('CLINE_WORKER_START_FAILED') })
    child.on('disconnect', () => { if (!shuttingDown && !closed) onFailure('CLINE_WORKER_DISCONNECTED') })
    child.on('close', () => {
      closed = true
      resolveClosed()
      if (!shuttingDown) onFailure('CLINE_WORKER_EXITED')
    })
    const drain = (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > CLINE_LIMITS.outputBytes && !shuttingDown) onFailure('CLINE_OUTPUT_LIMIT')
    }
    child.stdout?.on('data', drain)
    child.stderr?.on('data', drain)
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') onFailure('CLINE_SHUTDOWN_FAILED')
      }
    }
    return {
      send(message) {
        if (closed || shuttingDown || !child.connected || !boundedFrame(message) || pendingSends >= 32) return Promise.reject(new Error('CLINE_IPC_SEND_FAILED'))
        pendingSends++
        return new Promise<void>((resolve, reject) => {
          child.send(message, error => { pendingSends--; if (error) reject(new Error('CLINE_IPC_SEND_FAILED')); else resolve() })
        })
      },
      shutdown() {
        if (shutdownPromise) return shutdownPromise
        shuttingDown = true
        shutdownPromise = (async () => {
          // Give the owned SDK session its stop window, then kill the complete owned group.
          await settleWithin(closePromise, 300)
          killGroup('SIGTERM')
          await settleWithin(closePromise, 300)
          killGroup('SIGKILL')
          await settleWithin(closePromise, 300)
          child.removeListener('message', onMessage)
          if (closed) await rm(home, { recursive: true, force: true })
          else throw new Error('CLINE_SHUTDOWN_UNCONFIRMED')
        })()
        return shutdownPromise
      },
    }
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
}
