import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const AGENT_EXECUTION_HARNESS_PROFILE_V1_SCHEMA =
  'dzupagent.agentExecutionHarnessProfile/v1' as const
export const AGENT_EXECUTION_HARNESS_RESULT_V1_SCHEMA =
  'dzupagent.agentExecutionHarnessResult/v1' as const

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TOOL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FORBIDDEN_REF_TOOLS = new Set([
  'git.update-ref', 'git.branch', 'git.push', 'git.fetch', 'git.merge',
  'git.rebase', 'git.cherry-pick', 'scm.update-ref', 'scm.push',
])

export interface AgentExecutionHarnessProfileV1 {
  readonly schemaVersion: typeof AGENT_EXECUTION_HARNESS_PROFILE_V1_SCHEMA
  readonly profileId: string
  readonly taskId: string
  readonly attemptId: string
  readonly workRoot: string
  readonly visibleTools: readonly string[]
  readonly mutationPolicy: {
    readonly allowedRelativePaths: readonly string[]
    readonly allowedCommandRefs: readonly string[]
    readonly denyOutsideWorkRoot: true
    readonly denySymlinkTraversal: true
    readonly refOperations: 'deny_all'
    readonly readBeforeWriteStamps: 'required' | 'disabled'
    readonly clearReadStampsOnCompaction: true
  }
  readonly limits: {
    readonly maxDurationMs: number
    readonly maxIterations: number
    readonly maxOutputBytes: number
    readonly maxChildProcesses: number
  }
  readonly progress: {
    readonly heartbeatIntervalMs: number
    readonly maxSilenceMs: number
  }
  readonly retention: {
    readonly retainRawPrompt: false
    readonly retainToolArguments: false
    readonly retainRawPaths: false
    readonly retainSecrets: false
  }
  readonly profileHash: string
}

export interface AgentExecutionHarnessProfileInputV1 {
  readonly profileId: string
  readonly taskId: string
  readonly attemptId: string
  readonly workRoot: string
  readonly visibleTools: readonly string[]
  readonly allowedRelativePaths: readonly string[]
  readonly allowedCommandRefs?: readonly string[]
  readonly readBeforeWriteStamps?: 'required' | 'disabled'
  readonly limits: AgentExecutionHarnessProfileV1['limits']
  readonly progress: AgentExecutionHarnessProfileV1['progress']
}

export type AgentExecutionHarnessReasonCode =
  | 'HARNESS_COMPLETED'
  | 'HARNESS_CANCELLED'
  | 'HARNESS_DURATION_EXCEEDED'
  | 'HARNESS_ITERATION_LIMIT'
  | 'HARNESS_OUTPUT_LIMIT'
  | 'HARNESS_TOOL_HIDDEN'
  | 'HARNESS_PATH_OUTSIDE_ROOT'
  | 'HARNESS_PATH_NOT_ALLOWED'
  | 'HARNESS_SYMLINK_REJECTED'
  | 'HARNESS_REF_OPERATION_FORBIDDEN'
  | 'HARNESS_READ_STAMP_REQUIRED'
  | 'HARNESS_READ_STAMP_STALE'
  | 'HARNESS_CHILD_LIMIT'
  | 'HARNESS_COMMAND_REF_FORBIDDEN'
  | 'HARNESS_CHILD_CLEANUP_FAILED'
  | 'HARNESS_PROGRESS_STALLED'
  | 'HARNESS_PORT_FAILED'

export interface AgentExecutionHarnessResultV1 {
  readonly schemaVersion: typeof AGENT_EXECUTION_HARNESS_RESULT_V1_SCHEMA
  readonly profileHash: string
  readonly taskId: string
  readonly attemptId: string
  readonly status: 'completed' | 'rejected' | 'cancelled' | 'timed_out' | 'failed'
  readonly reasonCodes: readonly AgentExecutionHarnessReasonCode[]
  readonly iterations: number
  readonly durationMs: number
  readonly outputBytes: number
  readonly observedPathHashes: readonly string[]
  readonly evidenceRefs: readonly string[]
  /** Conservative count of child processes whose termination could not be verified. */
  readonly activeChildProcesses: number
  readonly childCleanupVerified: boolean
  readonly rawPromptRetained: false
  readonly rawToolArgumentsRetained: false
  readonly secretScanPassed: true
  readonly resultHash: string
}

export type AgentExecutionHarnessAction =
  | { readonly kind: 'read'; readonly tool: string; readonly path: string }
  | { readonly kind: 'write'; readonly tool: string; readonly path: string; readonly content: string | Uint8Array; readonly expectedReadStamp?: string }
  | { readonly kind: 'ref'; readonly tool: string; readonly operation: string }
  | { readonly kind: 'spawn'; readonly tool: string; readonly commandRef: string }
  | { readonly kind: 'output'; readonly tool: string; readonly byteLength: number }
  | { readonly kind: 'progress'; readonly tool: string; readonly phase: string }
  | { readonly kind: 'compact'; readonly tool: string }

export interface AgentExecutionHarnessChild {
  readonly id: string
  terminate(): void | Promise<void>
  wait(): void | Promise<void>
}

export interface AgentExecutionHarnessPorts {
  readonly readFile: (absolutePath: string) => string | Uint8Array
  readonly writeFile: (absolutePath: string, content: string | Uint8Array) => void | Promise<void>
  readonly spawnChild: (commandRef: string) => AgentExecutionHarnessChild | Promise<AgentExecutionHarnessChild>
  readonly emitEvidence?: (event: Readonly<Record<string, string | number | boolean>>) => void
  readonly now?: () => number
}

export interface RunAgentExecutionHarnessInput {
  readonly profile: AgentExecutionHarnessProfileV1
  readonly actions: readonly AgentExecutionHarnessAction[]
  readonly ports: AgentExecutionHarnessPorts
  readonly signal?: AbortSignal
  /** Accepted for invocation compatibility, deliberately never retained. */
  readonly rawPrompt?: string
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex')
}

function isSafeRelativePattern(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false
  const parts = value.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false
  const stars = parts.filter((part) => part.includes('*'))
  return stars.length === 0 || (stars.length === 1 && parts.at(-1) === '**')
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort())
}

export function createAgentExecutionHarnessProfileV1(
  input: AgentExecutionHarnessProfileInputV1,
): AgentExecutionHarnessProfileV1 {
  const content = {
    schemaVersion: AGENT_EXECUTION_HARNESS_PROFILE_V1_SCHEMA,
    profileId: input.profileId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    workRoot: input.workRoot,
    visibleTools: uniqueSorted(input.visibleTools),
    mutationPolicy: {
      allowedRelativePaths: uniqueSorted(input.allowedRelativePaths),
      allowedCommandRefs: uniqueSorted(input.allowedCommandRefs ?? []),
      denyOutsideWorkRoot: true as const,
      denySymlinkTraversal: true as const,
      refOperations: 'deny_all' as const,
      readBeforeWriteStamps: input.readBeforeWriteStamps ?? 'required',
      clearReadStampsOnCompaction: true as const,
    },
    limits: Object.freeze({ ...input.limits }),
    progress: Object.freeze({ ...input.progress }),
    retention: {
      retainRawPrompt: false as const,
      retainToolArguments: false as const,
      retainRawPaths: false as const,
      retainSecrets: false as const,
    },
  }
  const profile = Object.freeze({ ...content, profileHash: digest(content) })
  const validation = validateAgentExecutionHarnessProfileV1(profile)
  if (!validation.valid) throw new TypeError(`AGENT_EXECUTION_HARNESS_PROFILE_INVALID: ${validation.errors.join('; ')}`)
  return profile
}

export function validateAgentExecutionHarnessProfileV1(value: unknown): { readonly valid: boolean; readonly errors: readonly string[] } {
  const errors: string[] = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['profile must be an object'] }
  const profile = value as Record<string, unknown>
  const exact = ['schemaVersion', 'profileId', 'taskId', 'attemptId', 'workRoot', 'visibleTools', 'mutationPolicy', 'limits', 'progress', 'retention', 'profileHash']
  if (Object.keys(profile).sort().join(',') !== [...exact].sort().join(',')) errors.push('profile fields must be exact')
  if (profile['schemaVersion'] !== AGENT_EXECUTION_HARNESS_PROFILE_V1_SCHEMA) errors.push('schemaVersion is unsupported')
  for (const field of ['profileId', 'taskId', 'attemptId']) if (!ID.test(String(profile[field] ?? ''))) errors.push(`${field} is invalid`)
  if (typeof profile['workRoot'] !== 'string' || !path.isAbsolute(profile['workRoot']) || path.resolve(profile['workRoot']) !== profile['workRoot']) errors.push('workRoot must be an absolute normalized path')
  const tools = profile['visibleTools']
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > 64 || stableJson(tools) !== stableJson(uniqueSorted(tools as string[])) ||
      tools.some((tool) => typeof tool !== 'string' || !TOOL.test(tool) || FORBIDDEN_REF_TOOLS.has(tool.toLowerCase()))) errors.push('visibleTools are invalid or expose a ref operation')
  const mutation = profile['mutationPolicy'] as Record<string, unknown> | undefined
  if (!mutation || Object.keys(mutation).sort().join(',') !== ['allowedCommandRefs', 'allowedRelativePaths', 'clearReadStampsOnCompaction', 'denyOutsideWorkRoot', 'denySymlinkTraversal', 'readBeforeWriteStamps', 'refOperations'].sort().join(',') ||
      mutation['denyOutsideWorkRoot'] !== true || mutation['denySymlinkTraversal'] !== true || mutation['refOperations'] !== 'deny_all' ||
      mutation['clearReadStampsOnCompaction'] !== true || !['required', 'disabled'].includes(String(mutation['readBeforeWriteStamps'])) ||
      !Array.isArray(mutation['allowedRelativePaths']) || mutation['allowedRelativePaths'].length === 0 ||
      stableJson(mutation['allowedRelativePaths']) !== stableJson(uniqueSorted(mutation['allowedRelativePaths'] as string[])) ||
      (mutation['allowedRelativePaths'] as unknown[]).some((entry) => typeof entry !== 'string' || !isSafeRelativePattern(entry)) ||
      !Array.isArray(mutation['allowedCommandRefs']) || mutation['allowedCommandRefs'].length > 128 ||
      stableJson(mutation['allowedCommandRefs']) !== stableJson(uniqueSorted(mutation['allowedCommandRefs'] as string[])) ||
      (mutation['allowedCommandRefs'] as unknown[]).some((entry) => typeof entry !== 'string' || !ID.test(entry))) errors.push('mutationPolicy is invalid')
  const limits = profile['limits'] as Record<string, unknown> | undefined
  if (!limits || Object.keys(limits).sort().join(',') !== ['maxChildProcesses', 'maxDurationMs', 'maxIterations', 'maxOutputBytes'].sort().join(',') ||
      Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || Number(limit) < 1) || Number(limits['maxDurationMs']) > 7_200_000 ||
      Number(limits['maxIterations']) > 10_000 || Number(limits['maxOutputBytes']) > 1_000_000_000 || Number(limits['maxChildProcesses']) > 64) errors.push('limits are invalid')
  const progress = profile['progress'] as Record<string, unknown> | undefined
  if (!progress || Object.keys(progress).sort().join(',') !== ['heartbeatIntervalMs', 'maxSilenceMs'].sort().join(',') ||
      !Number.isSafeInteger(progress['heartbeatIntervalMs']) || Number(progress['heartbeatIntervalMs']) < 1 ||
      !Number.isSafeInteger(progress['maxSilenceMs']) || Number(progress['maxSilenceMs']) < Number(progress['heartbeatIntervalMs']) ||
      Number(progress['maxSilenceMs']) > Number(limits?.['maxDurationMs'] ?? 0)) errors.push('progress bounds are invalid')
  const retention = profile['retention'] as Record<string, unknown> | undefined
  if (!retention || Object.keys(retention).sort().join(',') !== ['retainRawPaths', 'retainRawPrompt', 'retainSecrets', 'retainToolArguments'].sort().join(',') ||
      Object.values(retention).some((entry) => entry !== false)) errors.push('retention must deny raw sensitive evidence')
  if (!HASH.test(String(profile['profileHash'] ?? ''))) errors.push('profileHash is invalid')
  else {
    const content = { ...profile }
    delete content['profileHash']
    if (digest(content) !== profile['profileHash']) errors.push('profileHash does not match content')
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) })
}

function pathMatches(relative: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pattern === relative || pattern === '**' ||
    (pattern.endsWith('/**') && (relative === pattern.slice(0, -3) || relative.startsWith(pattern.slice(0, -2)))))
}

function resolveGuardedPath(root: string, requested: string): { absolute: string; relative: string } {
  const absolute = path.resolve(root, requested)
  const relative = path.relative(root, absolute).replaceAll(path.sep, '/')
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('HARNESS_PATH_OUTSIDE_ROOT')
  const nearest = (() => {
    let cursor = absolute
    while (cursor !== root) {
      try { lstatSync(cursor); return cursor } catch { cursor = path.dirname(cursor) }
    }
    return root
  })()
  const real = realpathSync(nearest)
  const realRelative = path.relative(root, real)
  if (real !== nearest || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('HARNESS_SYMLINK_REJECTED')
  return { absolute, relative }
}

function contentBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content
}

/** Opaque read stamp returned to a tool caller; it contains no file bytes. */
export function computeAgentExecutionReadStamp(content: string | Uint8Array): string {
  return digest([...contentBytes(content)])
}

/**
 * Structural adapter for the existing model-call `HarnessProfile` override.
 * The model profile remains a separate contract and is neither renamed nor
 * granted filesystem/ref authority by this projection.
 */
export function toModelHarnessToolVisibility(
  profile: AgentExecutionHarnessProfileV1,
): { readonly include: readonly string[] } {
  if (!validateAgentExecutionHarnessProfileV1(profile).valid) {
    throw new TypeError('AGENT_EXECUTION_HARNESS_PROFILE_INVALID')
  }
  return Object.freeze({ include: profile.visibleTools })
}

export async function runAgentExecutionHarness(input: RunAgentExecutionHarnessInput): Promise<AgentExecutionHarnessResultV1> {
  const validation = validateAgentExecutionHarnessProfileV1(input.profile)
  if (!validation.valid) throw new TypeError('AGENT_EXECUTION_HARNESS_PROFILE_INVALID')
  const root = realpathSync(input.profile.workRoot)
  if (root !== input.profile.workRoot) throw new TypeError('AGENT_EXECUTION_HARNESS_WORK_ROOT_INVALID')
  const now = input.ports.now ?? Date.now
  const startedAt = now()
  let lastProgressAt = startedAt
  let iterations = 0
  let outputBytes = 0
  let status: AgentExecutionHarnessResultV1['status'] = 'completed'
  let reason: AgentExecutionHarnessReasonCode = 'HARNESS_COMPLETED'
  const pathHashes = new Set<string>()
  const evidenceRefs = new Set<string>()
  const readStamps = new Map<string, string>()
  const children = new Map<string, AgentExecutionHarnessChild>()
  const cleanupRuns: Array<Promise<number>> = []
  let childCleanupVerified = true
  let unverifiedChildProcesses = 0
  let cancelled = input.signal?.aborted === true

  const emit = (kind: string, data: Record<string, string | number | boolean> = {}): void => {
    const event = Object.freeze({ kind, taskId: input.profile.taskId, attemptId: input.profile.attemptId, ...data })
    const eventHash = digest(event)
    evidenceRefs.add(`evidence:harness:${eventHash}`)
    input.ports.emitEvidence?.(Object.freeze({ ...event, eventHash }))
  }
  const cleanupChild = async (child: AgentExecutionHarnessChild): Promise<number> => {
    let verified = true
    if (!child || typeof child.terminate !== 'function' || typeof child.wait !== 'function') return 1
    try { await child.terminate() } catch { verified = false }
    try { await child.wait() } catch { verified = false }
    return verified ? 0 : 1
  }
  const terminateChildren = async (): Promise<number> => {
    const active = [...children.values()]
    children.clear()
    const run = Promise.all(active.map(cleanupChild)).then((outcomes) => outcomes.reduce((sum, count) => sum + count, 0))
    cleanupRuns.push(run)
    return run
  }
  const cancelListener = (): void => { cancelled = true; void terminateChildren() }
  input.signal?.addEventListener('abort', cancelListener, { once: true })

  try {
    for (const action of input.actions) {
      if (cancelled) { status = 'cancelled'; reason = 'HARNESS_CANCELLED'; break }
      const elapsed = now() - startedAt
      if (elapsed > input.profile.limits.maxDurationMs) { status = 'timed_out'; reason = 'HARNESS_DURATION_EXCEEDED'; break }
      if (now() - lastProgressAt > input.profile.progress.maxSilenceMs) { status = 'timed_out'; reason = 'HARNESS_PROGRESS_STALLED'; break }
      iterations += 1
      if (iterations > input.profile.limits.maxIterations) { status = 'rejected'; reason = 'HARNESS_ITERATION_LIMIT'; break }
      if (!input.profile.visibleTools.includes(action.tool)) { status = 'rejected'; reason = 'HARNESS_TOOL_HIDDEN'; break }
      try {
        if (action.kind === 'ref') {
          status = 'rejected'; reason = 'HARNESS_REF_OPERATION_FORBIDDEN'; emit('ref_rejected', { operationHash: digest(action.operation) }); break
        }
        if (action.kind === 'read' || action.kind === 'write') {
          const guarded = resolveGuardedPath(root, action.path)
          const pathHash = digest(guarded.relative)
          pathHashes.add(pathHash)
          if (action.kind === 'read') {
            const bytes = contentBytes(input.ports.readFile(guarded.absolute))
            readStamps.set(guarded.absolute, computeAgentExecutionReadStamp(bytes))
            emit('read_observed', { pathHash })
          } else {
            if (!pathMatches(guarded.relative, input.profile.mutationPolicy.allowedRelativePaths)) {
              status = 'rejected'; reason = 'HARNESS_PATH_NOT_ALLOWED'; emit('write_rejected', { pathHash }); break
            }
            if (input.profile.mutationPolicy.readBeforeWriteStamps === 'required') {
              const retained = readStamps.get(guarded.absolute)
              if (!retained || action.expectedReadStamp !== retained) {
                status = 'rejected'; reason = 'HARNESS_READ_STAMP_REQUIRED'; emit('write_rejected', { pathHash }); break
              }
              let current: string
              try { current = computeAgentExecutionReadStamp(input.ports.readFile(guarded.absolute)) } catch { current = computeAgentExecutionReadStamp(new Uint8Array()) }
              if (current !== retained) { status = 'rejected'; reason = 'HARNESS_READ_STAMP_STALE'; emit('write_rejected', { pathHash }); break }
            }
            await input.ports.writeFile(guarded.absolute, action.content)
            const writtenStamp = computeAgentExecutionReadStamp(action.content)
            if (computeAgentExecutionReadStamp(input.ports.readFile(guarded.absolute)) !== writtenStamp) throw new Error('HARNESS_PORT_FAILED')
            readStamps.set(guarded.absolute, writtenStamp)
            emit('write_observed', { pathHash, byteLength: contentBytes(action.content).byteLength })
          }
          continue
        }
        if (action.kind === 'spawn') {
          if (!input.profile.mutationPolicy.allowedCommandRefs.includes(action.commandRef)) {
            status = 'rejected'; reason = 'HARNESS_COMMAND_REF_FORBIDDEN'; emit('child_rejected', { commandRefHash: digest(action.commandRef) }); break
          }
          if (children.size >= input.profile.limits.maxChildProcesses) { status = 'rejected'; reason = 'HARNESS_CHILD_LIMIT'; break }
          const child = await input.ports.spawnChild(action.commandRef)
          if (!child || !ID.test(child.id || '') || typeof child.terminate !== 'function' || typeof child.wait !== 'function' || children.has(child.id)) {
            const cleanup = cleanupChild(child)
            cleanupRuns.push(cleanup)
            await cleanup
            status = 'rejected'; reason = 'HARNESS_PORT_FAILED'; emit('child_rejected', { commandRefHash: digest(action.commandRef) }); break
          }
          children.set(child.id, child)
          emit('child_started', { childIdHash: digest(child.id), commandRefHash: digest(action.commandRef) })
          continue
        }
        if (action.kind === 'output') {
          if (!Number.isSafeInteger(action.byteLength) || action.byteLength < 0 || outputBytes + action.byteLength > input.profile.limits.maxOutputBytes) {
            status = 'rejected'; reason = 'HARNESS_OUTPUT_LIMIT'; break
          }
          outputBytes += action.byteLength
          emit('output_observed', { byteLength: action.byteLength })
          continue
        }
        if (action.kind === 'progress') {
          lastProgressAt = now()
          emit('progress', { phaseHash: digest(action.phase) })
          continue
        }
        if (action.kind === 'compact') {
          readStamps.clear()
          emit('compacted', { readStampCount: 0 })
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        status = 'rejected'
        reason = code === 'HARNESS_PATH_OUTSIDE_ROOT' ? 'HARNESS_PATH_OUTSIDE_ROOT'
          : code === 'HARNESS_SYMLINK_REJECTED' ? 'HARNESS_SYMLINK_REJECTED' : 'HARNESS_PORT_FAILED'
        emit('action_rejected', { reasonCode: reason })
        break
      }
    }
  } finally {
    input.signal?.removeEventListener('abort', cancelListener)
    await terminateChildren()
    unverifiedChildProcesses = (await Promise.all(cleanupRuns)).reduce((sum, count) => sum + count, 0)
    childCleanupVerified = unverifiedChildProcesses === 0
    if (!childCleanupVerified) {
      status = 'failed'
      reason = 'HARNESS_CHILD_CLEANUP_FAILED'
      emit('child_cleanup_failed')
    }
  }
  const content = {
    schemaVersion: AGENT_EXECUTION_HARNESS_RESULT_V1_SCHEMA,
    profileHash: input.profile.profileHash,
    taskId: input.profile.taskId,
    attemptId: input.profile.attemptId,
    status,
    reasonCodes: Object.freeze([reason]),
    iterations,
    durationMs: Math.max(0, now() - startedAt),
    outputBytes,
    observedPathHashes: Object.freeze([...pathHashes].sort()),
    evidenceRefs: Object.freeze([...evidenceRefs].sort()),
    activeChildProcesses: unverifiedChildProcesses,
    childCleanupVerified,
    rawPromptRetained: false as const,
    rawToolArgumentsRetained: false as const,
    secretScanPassed: true as const,
  }
  return Object.freeze({ ...content, resultHash: digest(content) })
}
