/**
 * Composable for streaming flow-compiler lifecycle events via WebSocket.
 *
 * Subscribes the shared playground WS connection (`useWsStore`) to a given
 * `compileId` via `subscribe:compile`, aggregates incoming `flow:compile_*`
 * events into an ordered per-stage summary, and exposes reactive state for a
 * progress UI.
 *
 * Wire protocol (mirrors `@dzupagent/server`'s `compile-messages.ts`):
 *
 *   Client -> Server: { type: 'subscribe:compile',   compileId }
 *   Client -> Server: { type: 'unsubscribe:compile', compileId }
 *   Server -> Client: { type: 'subscribed:compile'   | 'unsubscribed:compile', compileId }
 *   Server -> Client: forwarded `flow:compile_*` events carrying `compileId`
 *
 * @example
 * ```ts
 * const { run, subscribe, unsubscribe } = useCompileStream()
 * subscribe('c-42')
 * watch(() => run.value.status, (s) => console.log('compile', s))
 * ```
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useWsStore } from '../stores/ws-store.js'
import {
  COMPILE_STAGES,
  type CompileRunState,
  type CompileStage,
  type CompileStageStatus,
  type CompileStageSummary,
  type WsEvent,
} from '../types.js'

const COMPILE_EVENT_PREFIX = 'flow:compile_'

function emptyStages(): CompileStageSummary[] {
  return COMPILE_STAGES.map((stage) => ({ stage, status: 'pending' as CompileStageStatus }))
}

function emptyRun(): CompileRunState {
  return {
    compileId: null,
    status: 'idle',
    errorCount: 0,
    warningCount: 0,
    stages: emptyStages(),
  }
}

function stageFromEventType(type: string): CompileStage | null {
  if (!type.startsWith(COMPILE_EVENT_PREFIX)) return null
  const suffix = type.slice(COMPILE_EVENT_PREFIX.length)
  // `failed` is handled separately (terminal on any stage)
  if (suffix === 'failed') return null
  return (COMPILE_STAGES as readonly string[]).includes(suffix)
    ? (suffix as CompileStage)
    : null
}

function pickDetails(stage: CompileStage, event: Record<string, unknown>): Record<string, unknown> {
  const details: Record<string, unknown> = {}
  const fields: Record<CompileStage, readonly string[]> = {
    started: ['inputKind'],
    parsed: ['astNodeType', 'errorCount'],
    shape_validated: ['errorCount'],
    semantic_resolved: ['resolvedCount', 'personaCount', 'errorCount'],
    lowered: ['target', 'nodeCount', 'edgeCount', 'warningCount'],
    completed: ['target', 'durationMs'],
  }
  for (const key of fields[stage]) {
    if (event[key] !== undefined) details[key] = event[key]
  }
  return details
}

export interface UseCompileStreamReturn {
  /** Aggregated per-compile state (stages, status, totals) */
  run: Ref<CompileRunState>
  /** True while subscribed and no terminal event has been observed */
  isRunning: ComputedRef<boolean>
  /** Begin streaming a compile; resets prior state */
  subscribe: (compileId: string) => void
  /** Unsubscribe from the current compile (no-op if none) */
  unsubscribe: () => void
  /** Reset aggregated state without sending WS messages */
  reset: () => void
}

export function useCompileStream(): UseCompileStreamReturn {
  const ws = useWsStore()
  const run = ref<CompileRunState>(emptyRun())

  const isRunning = computed(
    () => run.value.status === 'subscribing' || run.value.status === 'running',
  )

  function applyEvent(raw: WsEvent): void {
    const type = raw.type
    if (typeof type !== 'string') return
    const compileId = raw['compileId']
    if (typeof compileId !== 'string' || compileId !== run.value.compileId) return

    const now = Date.now()
    const record = raw as unknown as Record<string, unknown>

    if (type === `${COMPILE_EVENT_PREFIX}failed`) {
      const stageNum = record['stage']
      const errorCount = typeof record['errorCount'] === 'number' ? record['errorCount'] : 0
      const durationMs = typeof record['durationMs'] === 'number' ? record['durationMs'] : 0
      const next = { ...run.value }
      next.status = 'failed'
      next.errorCount = errorCount
      next.durationMs = durationMs
      if (stageNum === 1 || stageNum === 2 || stageNum === 3 || stageNum === 4) {
        next.failure = { stage: stageNum, errorCount, durationMs }
      }
      next.stages = next.stages.map((s) =>
        s.status === 'active'
          ? { ...s, status: 'failed', endedAt: now, durationMs: s.startedAt ? now - s.startedAt : undefined }
          : s,
      )
      run.value = next
      return
    }

    const stage = stageFromEventType(type)
    if (!stage) return

    const next = { ...run.value }
    next.status = 'running'

    if (stage === 'completed') {
      const target = record['target']
      if (target === 'skill-chain' || target === 'workflow-builder' || target === 'pipeline') {
        next.target = target
      }
      if (typeof record['durationMs'] === 'number') next.durationMs = record['durationMs']
    }

    const stages = next.stages.slice()
    const idx = stages.findIndex((s) => s.stage === stage)
    if (idx === -1) {
      run.value = next
      return
    }

    // Close any earlier active stage
    for (let i = 0; i < idx; i++) {
      const prev = stages[i]
      if (!prev) continue
      if (prev.status === 'pending' || prev.status === 'active') {
        const endedAt = prev.endedAt ?? now
        stages[i] = {
          stage: prev.stage,
          status: 'done',
          startedAt: prev.startedAt,
          endedAt,
          durationMs: prev.startedAt ? endedAt - prev.startedAt : prev.durationMs,
          errorCount: prev.errorCount,
          details: prev.details,
        }
      }
    }

    const errorCount = typeof record['errorCount'] === 'number' ? record['errorCount'] : undefined
    if (errorCount !== undefined) next.errorCount = Math.max(next.errorCount, errorCount)
    if (stage === 'lowered' && typeof record['warningCount'] === 'number') {
      next.warningCount = record['warningCount']
    }

    const existing = stages[idx]
    const startedAt = existing?.startedAt ?? now
    stages[idx] = {
      stage,
      status: stage === 'completed' ? 'done' : 'active',
      startedAt,
      endedAt: stage === 'completed' ? now : undefined,
      durationMs: stage === 'completed' ? now - startedAt : undefined,
      errorCount,
      details: pickDetails(stage, record),
    }

    next.stages = stages
    if (stage === 'completed') next.status = 'completed'
    run.value = next
  }

  const stopWatch = watch(
    () => ws.lastEvent,
    (event) => {
      if (event) applyEvent(event)
    },
  )

  function reset(): void {
    run.value = emptyRun()
  }

  function subscribe(compileId: string): void {
    const trimmed = compileId.trim()
    if (trimmed.length === 0) return

    if (run.value.compileId && run.value.compileId !== trimmed) {
      ws.sendJson({ type: 'unsubscribe:compile', compileId: run.value.compileId })
    }

    const next = emptyRun()
    next.compileId = trimmed
    next.status = 'subscribing'
    run.value = next

    ws.sendJson({ type: 'subscribe:compile', compileId: trimmed })
  }

  function unsubscribe(): void {
    const current = run.value.compileId
    if (!current) return
    ws.sendJson({ type: 'unsubscribe:compile', compileId: current })
    run.value = { ...run.value, status: run.value.status === 'running' ? 'idle' : run.value.status }
  }

  // Cleanup on component unmount — watch() is bound to the calling instance's lifecycle.
  void stopWatch

  return { run, isRunning, subscribe, unsubscribe, reset }
}
