import { randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ClineApprovalRequest, ClineApprovalResult, ClineCoreInstance, ClineSdk, ClineStartInput } from './cline-sdk-types.js'
import type { ClineBinding, ClineChildMessage, ClineStart } from './cline-worker-protocol.js'
import { boundedFrame, CLINE_LIMITS, isParentMessage, sameBinding } from './cline-worker-protocol.js'
import { clineStreamEvent, clineUsage } from './cline-events.js'
import { clineChildEnv, settleWithin } from './cline-worker-transport.js'

export interface ClineWorkerChannel {
  send(message: ClineChildMessage): Promise<void>
  onMessage(listener: (message: unknown) => void): () => void
}
export interface ClineWorkerDependencies {
  /** Injected only by provider-free tests. Production imports after private environment setup. */
  loadSdk(start: ClineStart, home: string): Promise<ClineSdk>
}

async function checkPinnedPackages(): Promise<void> {
  for (const name of ['@cline/sdk', '@cline/core', '@cline/shared']) {
    let manifest: { name?: unknown; version?: unknown }
    try {
      // These pinned packages all export dist/index.js. Read package metadata only.
      const entry = fileURLToPath(import.meta.resolve(name))
      manifest = JSON.parse(await readFile(join(dirname(entry), '..', 'package.json'), 'utf8')) as typeof manifest
    } catch { throw new Error('CLINE_SDK_UNAVAILABLE') }
    if (manifest.name !== name || manifest.version !== '0.2.0') throw new Error('CLINE_SDK_VERSION_UNSUPPORTED')
  }
}

async function absent(path: string): Promise<void> {
  try { await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('CLINE_PROFILE_UNAVAILABLE')
  }
  throw new Error('CLINE_MCP_SETTINGS_UNSUPPORTED')
}
export const loadClineSdk: ClineWorkerDependencies['loadSdk'] = async (start, home) => {
  if (!isAbsolute(home) || !isAbsolute(start.profileDir) || !isAbsolute(start.cwd)) throw new Error('CLINE_ABSOLUTE_PATH_REQUIRED')
  // Runs only in a fresh dedicated Node process, before any upstream import.
  const env = clineChildEnv(process.env, home)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  const profile = await lstat(start.profileDir)
  if (!profile.isDirectory() || profile.isSymbolicLink()) throw new Error('CLINE_PROFILE_UNAVAILABLE')
  await checkPinnedPackages()
  const storageName = '@cline/shared/storage'
  const storage = await import(storageName) as {
    setHomeDir(path: string): void
    setClineDir(path: string): void
    resolveMcpSettingsPath(): string
  }
  storage.setHomeDir(home)
  storage.setClineDir(start.profileDir)
  // Do not read credentials or MCP configuration. Refuse a provisioned MCP settings file.
  await absent(storage.resolveMcpSettingsPath())
  await absent(join(start.cwd, '.cline', 'cline_mcp_settings.json'))
  const sdkName = '@cline/sdk'
  return await import(sdkName) as ClineSdk
}

export function runClineWorker(
  channel: ClineWorkerChannel, binding: ClineBinding, home: string,
  dependencies: ClineWorkerDependencies = { loadSdk: loadClineSdk },
): { done: Promise<void>; cancel(): void } {
  let core: ClineCoreInstance | undefined
  let started = false
  let cancelled = false
  let cancellationCode = 'CLINE_CANCELLED'
  let terminal = false
  let bytes = 0
  let sends = 0
  let unsubscribe: (() => void) | undefined
  let stopPromise: Promise<void> | undefined
  let resolveDone!: () => void
  let unlisten = () => undefined as void
  const done = new Promise<void>(resolve => { resolveDone = resolve })
  const approvals = new Map<string, { resolve(value: ClineApprovalResult): void; timer: ReturnType<typeof setTimeout> }>()
  const denyAll = () => {
    for (const item of approvals.values()) { clearTimeout(item.timer); item.resolve({ approved: false, reason: 'Permission cancelled' }) }
    approvals.clear()
  }
  const stop = () => {
    if (core && !stopPromise) stopPromise = Promise.resolve().then(() => core!.stop(binding.sessionId)).catch(() => undefined)
    return stopPromise ?? Promise.resolve()
  }
  const cancel = (code = 'CLINE_CANCELLED') => {
    if (!cancelled) cancellationCode = code
    cancelled = true; denyAll(); void stop()
  }
  const send = async (message: ClineChildMessage) => {
    if (!boundedFrame(message)) throw new Error('CLINE_FRAME_LIMIT')
    if (sends >= 32) throw new Error('CLINE_IPC_BACKPRESSURE')
    bytes += Buffer.byteLength(JSON.stringify(message))
    if (bytes > CLINE_LIMITS.outputBytes) throw new Error('CLINE_OUTPUT_LIMIT')
    sends++
    try { await channel.send(message) } finally { sends-- }
  }
  const finish = async (message: ClineChildMessage) => {
    if (terminal) return
    terminal = true
    denyAll()
    try { await send(message) } catch { /* Parent owns the bounded process shutdown on IPC failure. */ }
  }
  const execute = async (start: ClineStart) => {
    try {
      if (cancelled) throw new Error(cancellationCode)
      if (!isAbsolute(start.profileDir) || !isAbsolute(start.cwd)) throw new Error('CLINE_ABSOLUTE_PATH_REQUIRED')
      const sdk = await dependencies.loadSdk(start, home)
      if (cancelled) throw new Error('CLINE_CANCELLED')
      const requestToolApproval = async (request: ClineApprovalRequest): Promise<ClineApprovalResult> => {
        if (cancelled || terminal || request.sessionId !== binding.sessionId || !start.enableTools || approvals.size >= CLINE_LIMITS.approvals) return { approved: false }
        const requestId = randomUUID()
        let timer!: ReturnType<typeof setTimeout>
        const answer = new Promise<ClineApprovalResult>(resolve => {
          timer = setTimeout(() => { approvals.delete(requestId); resolve({ approved: false, reason: 'Permission expired' }) }, start.approvalTimeoutMs)
          approvals.set(requestId, { timer, resolve })
        })
        try { await send({ ...binding, type: 'approval_request', requestId, toolName: request.toolName }) }
        catch { clearTimeout(timer); approvals.get(requestId)?.resolve({ approved: false }); approvals.delete(requestId); cancel('CLINE_IPC_SEND_FAILED') }
        return answer
      }
      const toolPolicies = { '*': { enabled: start.enableTools, autoApprove: false as const } }
      const capabilities = { requestToolApproval }
      core = await sdk.ClineCore.create({ backendMode: 'local', automation: false, clientName: 'dzupagent-cline',
        distinctId: binding.runId, toolPolicies, capabilities })
      if (cancelled) throw new Error('CLINE_CANCELLED')
      // Bind before start, including all events emitted synchronously during startup.
      unsubscribe = core.subscribe(event => {
        if (cancelled || terminal) return
        try {
          const mapped = clineStreamEvent(event, binding.sessionId)
          if (mapped) void send({ ...binding, type: 'event', event: mapped }).catch(error => {
            cancel(error instanceof Error && /^CLINE_[A-Z0-9_]+$/.test(error.message) ? error.message : 'CLINE_IPC_SEND_FAILED')
          })
        } catch { cancel('CLINE_EVENT_INVALID') }
      }, { sessionId: binding.sessionId })
      const input: ClineStartInput = {
        config: { sessionId: binding.sessionId, cwd: start.cwd, workspaceRoot: start.cwd, providerId: start.provider,
          modelId: start.model, systemPrompt: start.systemPrompt, mode: 'act', enableTools: start.enableTools,
          enableSpawnAgent: false, enableAgentTeams: false, disableMcpSettingsTools: true, mcpApps: false, yolo: false,
          pluginPaths: [], agentPluginPaths: [], extensions: [], skills: [], checkpoint: { enabled: false },
          compaction: { enabled: false }, toolPolicies, ...(start.maxIterations ? { maxIterations: start.maxIterations } : {}) },
        prompt: start.prompt, interactive: false, localRuntime: { configExtensions: [], extensions: [], extraTools: [] },
        plugins: { '*': { enabled: false } }, toolPolicies, capabilities,
      }
      const result = await core.start(input)
      if (result.sessionId !== binding.sessionId) throw new Error('CLINE_SESSION_MISMATCH')
      if (cancelled) throw new Error('CLINE_CANCELLED')
      const success = result.result?.finishReason === 'completed' && typeof result.result.text === 'string'
      const usage = clineUsage(result.result?.usage)
      await finish({ ...binding, type: 'result', success, text: typeof result.result?.text === 'string' ? result.result.text : '',
        reason: success ? 'completed' : 'CLINE_RUN_FAILED', ...(usage ? { usage } : {}) })
    } catch (error) {
      const code = cancelled ? cancellationCode : error instanceof Error && /^CLINE_[A-Z0-9_]+$/.test(error.message) ? error.message : 'CLINE_SDK_FAILED'
      await finish({ ...binding, type: 'fatal', code })
    } finally {
      denyAll()
      unsubscribe?.()
      await settleWithin(stop(), 200)
      if (core) await settleWithin(Promise.resolve().then(() => core!.dispose()), 200)
      unlisten()
      resolveDone()
    }
  }
  unlisten = channel.onMessage(message => {
    if (terminal) return
    if (!isParentMessage(message) || !sameBinding(message, binding)) {
      cancel('CLINE_IPC_INVALID')
      void finish({ ...binding, type: 'fatal', code: 'CLINE_IPC_INVALID' }).then(() => {
        if (!started) { unlisten(); resolveDone() }
      })
      return
    }
    if (message.type === 'cancel') { cancel(); if (!started) { unlisten(); resolveDone() }; return }
    if (message.type === 'approval_response') {
      const pending = approvals.get(message.requestId)
      if (pending) { clearTimeout(pending.timer); approvals.delete(message.requestId); pending.resolve({ approved: message.approved && !cancelled && !terminal }) }
      return
    }
    if (started || cancelled) { cancel('CLINE_IPC_ORDER'); return }
    started = true
    void execute(message).catch(() => { cancel(); resolveDone() })
  })
  void send({ ...binding, type: 'ready' }).catch(() => { cancel(); if (!started) { unlisten(); resolveDone() } })
  return { done, cancel: () => cancel() }
}

// No side effects when imported by deterministic unit tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--dzup-cline-worker') {
  const [runId, sessionId, home] = process.argv.slice(3)
  if (!runId || !sessionId || !home || !process.send) process.exitCode = 1
  else {
    const worker = runClineWorker({
      send: message => new Promise((resolve, reject) => { process.send!(message, error => error ? reject(error) : resolve()) }),
      onMessage(listener) { process.on('message', listener); return () => { process.off('message', listener) } },
    }, { version: 1, runId, sessionId }, home)
    process.once('disconnect', worker.cancel)
    void worker.done.then(() => { if (process.connected) process.disconnect() })
  }
}
