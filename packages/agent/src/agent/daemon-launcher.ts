/**
 * Daemon launcher — extracted from DzupAgent.launch() body.
 *
 * `launchDaemon()` starts an agent run in the background and returns a
 * {@link RunHandle} that resolves within milliseconds, before the run
 * completes. The handle provides cooperative pause/resume, cancellation,
 * and result awaiting.
 *
 * The extraction keeps the DzupAgent class slim and allows the launch
 * lifecycle (runId allocation, journal setup, background execution) to
 * be unit-tested without instantiating a full agent.
 */

import { randomUUID } from 'node:crypto'
import type { BaseMessage } from '@langchain/core/messages'
import { InMemoryRunJournal } from '@dzupagent/core'
import type {
  GenerateOptions,
  GenerateResult,
} from './agent-types.js'
import type { RunHandle, LaunchOptions } from './run-handle-types.js'
import { ConcreteRunHandle } from './run-handle.js'

/**
 * Minimal surface area the launcher needs from the owning agent. Accepting
 * a narrow context (instead of the whole agent) keeps this module
 * unit-testable in isolation.
 */
export interface DaemonLauncherContext {
  agentId: string
  generate: (messages: BaseMessage[], options?: GenerateOptions) => Promise<GenerateResult>
}

/**
 * Launch an agent run in the background and return a {@link RunHandle}
 * immediately.
 *
 * Equivalent to `DzupAgent.launch()`; the class method is now a thin
 * wrapper that delegates here.
 */
export async function launchDaemon(
  ctx: DaemonLauncherContext,
  messages: BaseMessage[],
  options?: LaunchOptions & { generateOptions?: GenerateOptions },
): Promise<RunHandle> {
  const runId = options?.runId ?? randomUUID()
  const journal = new InMemoryRunJournal()
  const handle = new ConcreteRunHandle(runId, 'running', journal, options)

  // Write run_started entry
  void journal.append(runId, {
    type: 'run_started',
    data: { input: null, agentId: ctx.agentId, metadata: options?.metadata },
  })

  // Start execution asynchronously — do NOT await
  runInBackground(ctx, messages, handle, options?.generateOptions).catch(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      handle._fail(message)
    },
  )

  return handle
}

/**
 * Execute the agent generate loop in the background, completing the handle
 * when done. Called by {@link launchDaemon} without awaiting.
 */
async function runInBackground(
  ctx: DaemonLauncherContext,
  messages: BaseMessage[],
  handle: ConcreteRunHandle,
  generateOptions?: GenerateOptions,
): Promise<void> {
  const result = await ctx.generate(messages, generateOptions)
  handle._complete(result.content, {
    durationMs: undefined,
    totalTokens: (result.usage.totalInputTokens ?? 0) + (result.usage.totalOutputTokens ?? 0),
    // Surface the per-run memory frame on the public RunResult so callers
    // can inspect which memory context was attached to this run. Only
    // forward when defined (the field is optional on RunResult).
    ...(result.memoryFrame !== undefined ? { memoryFrame: result.memoryFrame } : {}),
  })
}
