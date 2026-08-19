import { performance } from 'node:perf_hooks'

import type { ProviderSessionAdapter } from '@dzupagent/adapter-types/provider-session'
import type {
  ProviderSessionAttemptBinding,
  ProviderSessionGoalClearRequest,
  ProviderSessionGoalGetRequest,
  ProviderSessionGoalSetRequest,
  ProviderSessionInterruptTurnRequest,
} from '@dzupagent/runtime-contracts/provider-session'

import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
} from '../types.js'
import {
  CodexAppServerClientError,
  CodexAppServerStdioClient,
  qualifyCodexAppServerExecutable,
  type CodexAppServerClientDependencies,
  type CodexAppServerClientLimits,
} from './codex-app-server-client.js'
import {
  MAX_REFERENCE_LENGTH,
  adapterError,
  cancellationDecision,
  decisionError,
  errorCode,
  sanitizedError,
  timeoutDecision,
  type ActiveRun,
  type CodexAppServerAdapterOptions,
  type InterruptTurnResult,
  type LocalTerminalDecision,
  type RunLifecycle,
  type RunningExecution,
} from './codex-app-server-adapter-contracts.js'
import {
  adapterConfig,
  clientDependencies,
  effectiveModel,
  effectiveWorkingDirectory,
  executionTimeout,
  interruptGrace,
  threadResumeParams,
  threadStartParams,
  turnStartParams,
} from './codex-app-server-adapter-config.js'
import { failedEvent, withCorrelation } from './codex-app-server-adapter-events.js'
import {
  assertAppServerAdmission,
  assertExactInterruptResponse,
  assertInput,
  assertInterruptRequest,
  boundedText,
} from './codex-app-server-adapter-validation.js'
import { consumeCodexAppServerTurn } from './codex-app-server-turn-stream.js'
import {
  createCodexGoalControlAdapter,
  type CodexGoalControlAdapter,
} from './codex-goal-control.js'
import {
  assertThreadResponse,
  assertTurnResponse,
} from './codex-app-server-protocol.js'
import type { ResolvedProbeExecutable } from '../introspection/index.js'

// PUBLIC API, not a convenience: `codex-goal-control.ts` (the package barrel) and
// `codex-backend.ts` both name the options type through THIS path, so it stays
// re-exported here after moving into the contracts layer. The re-export is
// explicit rather than `export *` to keep the run-state interfaces, constants and
// error factories the layering also shares out of the published surface.
export type { CodexAppServerAdapterOptions } from './codex-app-server-adapter-contracts.js'

/**
 * Experimental provider-session backend for the exact admitted App Server
 * descriptor. It emits normalized events but never emits raw frames or answers
 * a provider-initiated request.
 */
export class CodexAppServerAdapter implements AgentCLIAdapter, ProviderSessionAdapter {
  readonly providerId = 'codex' as const
  readonly attemptBinding: ProviderSessionAttemptBinding

  private config: AdapterConfig
  private readonly executable: ResolvedProbeExecutable
  private readonly clientLimits: CodexAppServerClientLimits | undefined
  private readonly clientDependencies: CodexAppServerClientDependencies | undefined
  private readonly now: () => number
  private readonly monotonicNow: () => number
  private readonly interruptGraceMs: number
  private readonly runningExecutions = new Set<RunningExecution>()
  private readonly activeRuns = new Set<ActiveRun>()
  private readonly goalControl: CodexGoalControlAdapter | undefined

  constructor(options: CodexAppServerAdapterOptions) {
    assertAppServerAdmission(options)
    this.attemptBinding = options.attemptBinding
    this.executable = options.executable
    this.clientLimits = options.clientLimits
    this.now = options.dependencies?.now ?? Date.now
    this.monotonicNow = options.dependencies?.monotonicNow ?? (() => performance.now())
    this.interruptGraceMs = interruptGrace(options.interruptGraceMs)
    this.clientDependencies = clientDependencies(options)
    this.config = adapterConfig(options)
    this.goalControl = options.attemptBinding.descriptor.capabilities['goal-control'].status === 'native'
      ? createCodexGoalControlAdapter({
          attemptBinding: options.attemptBinding,
          executable: options.executable,
          timeoutMs: options.clientLimits?.requestTimeoutMs,
          ...(options.env ? { env: options.env } : {}),
          ...(this.clientDependencies ? { dependencies: this.clientDependencies } : {}),
        })
      : undefined
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    yield* this.run(input)
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    if (!boundedText(sessionId, MAX_REFERENCE_LENGTH)) {
      yield failedEvent(
        this.now(),
        input.correlationId,
        'CODEX_APP_SERVER_SESSION_INVALID',
        'Codex app-server session reference is invalid',
      )
      return
    }
    yield* this.run(input, sessionId)
  }

  interrupt(): void {
    for (const execution of this.runningExecutions) execution.cancel()
  }

  configure(options: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...options }
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: false,
      emitsToolCalls: false,
      executesToolLoop: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      nativeToolControls: {
        mode: false,
        allowlist: false,
        blocklist: false,
      },
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await qualifyCodexAppServerExecutable({
        executable: this.executable,
        ...(this.clientLimits ? { limits: this.clientLimits } : {}),
        ...(this.clientDependencies ? { dependencies: this.clientDependencies } : {}),
      })
      return {
        healthy: true,
        providerId: this.providerId,
        sdkInstalled: false,
        cliAvailable: true,
        lastSuccessTimestamp: this.now(),
      }
    } catch {
      return {
        healthy: false,
        providerId: this.providerId,
        sdkInstalled: false,
        cliAvailable: false,
        lastError: 'Qualified Codex executable is unavailable',
      }
    }
  }

  async interruptTurn(
    request: ProviderSessionInterruptTurnRequest,
  ): Promise<InterruptTurnResult> {
    assertInterruptRequest(request, this.attemptBinding)
    const run = [...this.activeRuns].find((candidate) =>
      candidate.threadId === request.session.opaqueId
      && candidate.turnId === request.turn.opaqueId)
    if (!run) throw new Error('Codex app-server interrupt rejected a stale turn')
    this.decideActiveRun(run, cancellationDecision())
    await this.interruptActiveRun(run)
    return { kind: 'interrupt-turn', accepted: true }
  }

  async getGoal(
    request: ProviderSessionGoalGetRequest,
  ): Promise<ReturnType<NonNullable<CodexGoalControlAdapter['getGoal']>> extends Promise<infer T> ? T : never> {
    if (!this.goalControl) throw new Error('Codex app-server goal control is unsupported')
    return this.goalControl.getGoal(request)
  }

  async setGoal(
    request: ProviderSessionGoalSetRequest,
  ): Promise<ReturnType<NonNullable<CodexGoalControlAdapter['setGoal']>> extends Promise<infer T> ? T : never> {
    if (!this.goalControl) throw new Error('Codex app-server goal control is unsupported')
    return this.goalControl.setGoal(request)
  }

  async clearGoal(
    request: ProviderSessionGoalClearRequest,
  ): Promise<ReturnType<NonNullable<CodexGoalControlAdapter['clearGoal']>> extends Promise<infer T> ? T : never> {
    if (!this.goalControl) throw new Error('Codex app-server goal control is unsupported')
    return this.goalControl.clearGoal(request)
  }

  /**
   * Owns one execution end to end: deadline and cancellation wiring, connect,
   * thread and turn setup, then the turn's event stream, then cleanup. The
   * per-event mapping lives in `consumeCodexAppServerTurn`; what stays here is
   * everything that has to survive a failure -- the latched terminal decision and
   * the process the cleanup path has to close.
   */
  private async *run(
    input: AgentInput,
    resumeThreadId?: string,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    let client: CodexAppServerStdioClient | undefined
    let activeRun: ActiveRun | undefined
    let terminal: AgentEvent | undefined
    let cleanupError: Error | undefined
    const startedAt = this.now()
    const timeoutMs = executionTimeout(input, this.config)
    const lifecycle: RunLifecycle = {
      deadline: this.monotonicNow() + timeoutMs,
    }
    const setupAbortController = new AbortController()
    const signal = input.signal
    let signalListener: (() => void) | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined

    const decide = (decision: LocalTerminalDecision): void => {
      if (lifecycle.terminalDecision) return
      lifecycle.terminalDecision = decision
      setupAbortController.abort()
      if (activeRun) {
        this.beginTerminalCleanup(activeRun)
      } else if (client) {
        void client.close().catch(() => undefined)
      }
    }
    const runningExecution: RunningExecution = {
      cancel: () => decide(cancellationDecision()),
    }
    const requireRemaining = (): number => {
      if (signal?.aborted) decide(cancellationDecision())
      const remaining = Math.ceil(lifecycle.deadline - this.monotonicNow())
      if (remaining < 1) decide(timeoutDecision())
      if (lifecycle.terminalDecision) throw decisionError(lifecycle.terminalDecision)
      return remaining
    }

    try {
      this.runningExecutions.add(runningExecution)
      assertInput(input)
      signalListener = () => decide(cancellationDecision())
      signal?.addEventListener('abort', signalListener, { once: true })
      timeout = setTimeout(() => decide(timeoutDecision()), requireRemaining())
      client = await CodexAppServerStdioClient.connect({
        executable: this.executable,
        ...(effectiveWorkingDirectory(input, this.config)
          ? { cwd: effectiveWorkingDirectory(input, this.config) }
          : {}),
        ...(this.config.env ? { env: this.config.env } : {}),
        ...(this.clientLimits ? { limits: this.clientLimits } : {}),
        ...(this.clientDependencies ? { dependencies: this.clientDependencies } : {}),
      }, {
        timeoutMs: requireRemaining(),
        signal: setupAbortController.signal,
      })
      requireRemaining()

      const requestedCwd = effectiveWorkingDirectory(input, this.config)
      const requestedModel = effectiveModel(input, this.config)
      const requestedSandboxMode = this.config.sandboxMode
      const admittedVersion = this.attemptBinding.descriptor.backend.version!
      const threadResult = await client.request(
        resumeThreadId ? 'thread/resume' : 'thread/start',
        resumeThreadId
          ? threadResumeParams(resumeThreadId, input, this.config)
          : threadStartParams(input, this.config),
        { timeoutMs: requireRemaining() },
      )
      requireRemaining()
      const { threadId } = assertThreadResponse(threadResult, {
        version: admittedVersion,
        ...(resumeThreadId !== undefined ? { threadId: resumeThreadId } : {}),
        ...(requestedCwd !== undefined ? { cwd: requestedCwd } : {}),
        ...(requestedModel !== undefined ? { model: requestedModel } : {}),
        ...(requestedSandboxMode !== undefined ? { sandboxMode: requestedSandboxMode } : {}),
      })

      const turnResult = await client.request(
        'turn/start',
        turnStartParams(threadId, input, this.config),
        { timeoutMs: requireRemaining() },
      )
      requireRemaining()
      const { turnId } = assertTurnResponse(turnResult)

      activeRun = {
        client,
        threadId,
        turnId,
        timeoutMs,
        lifecycle,
      }
      this.activeRuns.add(activeRun)
      const run = activeRun
      requireRemaining()

      yield withCorrelation({
        type: 'adapter:started',
        providerId: this.providerId,
        sessionId: threadId,
        timestamp: this.now(),
        ...(effectiveModel(input, this.config) ? { model: effectiveModel(input, this.config) } : {}),
        ...(resumeThreadId ? { isResume: true } : {}),
      }, input.correlationId)

      terminal = yield* consumeCodexAppServerTurn(client.events(), {
        run,
        admittedVersion,
        correlationId: input.correlationId,
        startedAt,
        now: this.now,
        requireRemaining,
      })
      if (lifecycle.terminalDecision) throw decisionError(lifecycle.terminalDecision)
      if (!terminal) throw adapterError(
        'CODEX_APP_SERVER_STREAM_ENDED',
        'Codex app-server stream ended before terminal completion',
      )
    } catch (error) {
      if (!lifecycle.terminalDecision) {
        if (signal?.aborted) decide(cancellationDecision())
        else if (
          error instanceof CodexAppServerClientError
          && error.code === 'CODEX_APP_SERVER_TIMEOUT'
        ) decide(timeoutDecision())
        else if (this.monotonicNow() >= lifecycle.deadline) decide(timeoutDecision())
      }
      const normalized = lifecycle.terminalDecision
        ? decisionError(lifecycle.terminalDecision)
        : sanitizedError(error)
      terminal = failedEvent(
        this.now(),
        input.correlationId,
        errorCode(normalized),
        normalized.message,
        activeRun?.threadId,
      )
    } finally {
      if (timeout) clearTimeout(timeout)
      if (signal && signalListener) signal.removeEventListener('abort', signalListener)
      this.runningExecutions.delete(runningExecution)
      if (activeRun) this.activeRuns.delete(activeRun)
      if (client) {
        try {
          await client.close()
        } catch (error) {
          cleanupError = sanitizedError(error)
        }
      }
    }

    if (lifecycle.terminalDecision) {
      yield failedEvent(
        this.now(),
        input.correlationId,
        lifecycle.terminalDecision.code,
        lifecycle.terminalDecision.message,
        activeRun?.threadId,
      )
      return
    }
    if (cleanupError) {
      yield failedEvent(
        this.now(),
        input.correlationId,
        errorCode(cleanupError),
        cleanupError.message,
        activeRun?.threadId,
      )
      return
    }
    if (terminal) yield terminal
  }

  private decideActiveRun(run: ActiveRun, decision: LocalTerminalDecision): void {
    if (run.lifecycle.terminalDecision) return
    run.lifecycle.terminalDecision = decision
    this.beginTerminalCleanup(run)
  }

  private beginTerminalCleanup(run: ActiveRun): void {
    const acknowledgement = this.interruptActiveRun(run)
    void acknowledgement.then(
      () => run.client.close().catch(() => undefined),
      () => run.client.close().catch(() => undefined),
    )
  }

  private interruptActiveRun(run: ActiveRun): Promise<void> {
    if (!run.interruptPromise) {
      run.interruptPromise = run.client.request('turn/interrupt', {
        threadId: run.threadId,
        turnId: run.turnId,
      }, { timeoutMs: this.interruptGraceMs }).then((result) => {
        assertExactInterruptResponse(result)
      })
    }
    return run.interruptPromise
  }
}

export function createCodexAppServerAdapter(
  options: CodexAppServerAdapterOptions,
): CodexAppServerAdapter {
  return new CodexAppServerAdapter(options)
}
