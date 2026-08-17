/**
 * Union-return sweep — type-level lock for the last five supplied-callback
 * positions in `@dzupagent/agent`.
 *
 * TypeScript's void-returning-function leniency lets a callback that returns a
 * value satisfy a `=> void` position: `(e) => seen.push(e)` returns `number`,
 * yet is assignable to `(e: E) => void`. That leniency does NOT survive a
 * union — under `=> void | Promise<void>` the same expression-bodied arrow is
 * rejected with TS2322. So `=> void | Promise<void>`, which authors write
 * intending to be *more* permissive, is strictly *less* permissive for
 * consumers, and it does not even express awaitability: it admits only
 * `Promise<void>` exactly, and tsc reports nothing on a dropped `await`.
 *
 * Every type lock below is deliberately EXPRESSION-BODIED over an `Array.push`
 * so its body evaluates to `number`, and every one flows through the PORT type
 * (an `ApprovalConfig` annotation, a `LlmCallAuditSink` annotation, a call on
 * the real class/interface) rather than a hand-written local annotation. A
 * fixture that carries its own annotation is decoupled from the declaration
 * under test and locks nothing.
 *
 * This is a TYPE-level lock: vitest does not typecheck, so the guard that
 * actually enforces it is `tsc -p tsconfig.flipcheck.json --noEmit`
 * (`yarn typecheck:tests`), which includes `__tests__`.
 *
 * Sites pinned, and why each landed where it did:
 *
 *   1. approval/approval-types.ts        ApprovalConfig.webhookDLQ   => unknown
 *      `approval-gate.ts:384` AWAITS it inside a try/catch whose whole job is
 *      to swallow DLQ failures. `void` would say the gate ignores the result
 *      while the gate depends on the rejection.
 *   2. mailbox/types.ts                  AgentMailbox.subscribe      => void
 *   3. mailbox/agent-mailbox.ts          AgentMailboxImpl.subscribe  => void
 *      `agent-mailbox.ts:135` does `void Promise.resolve(handler(...)).catch()`
 *      — delivery never waits on the handler, so `void` is the true contract.
 *      (TS models rejections as untyped, so the `.catch` stays meaningful.)
 *   4. observability/llm-call-audit.ts   LlmCallAuditSink.record     => unknown
 *      `run-engine-generate-audit.ts:76` AWAITS it to convert a sink rejection
 *      into an `audit:sink_failure` event.
 *   5. orchestration/team/team-workspace.ts WorkspaceSubscriber      => unknown
 *      Not a judgement call: `notifySubscribers` tests the result for
 *      truthiness, and `void` is a hard TS1345 ("An expression of type 'void'
 *      cannot be tested for truthiness") — the compiler picks `unknown` here.
 */

import { describe, it, expect, vi } from 'vitest'
import { createEventBus, type DzupEvent } from '@dzupagent/core'
import { ApprovalGate } from '../approval/approval-gate.js'
import type { ApprovalConfig } from '../approval/approval-types.js'
import { AgentMailboxImpl } from '../mailbox/agent-mailbox.js'
import type {
  AgentMailbox,
  MailboxQuery,
  MailboxStore,
  MailMessage,
} from '../mailbox/types.js'
import { recordAuditEntry } from '../agent/run-engine-generate-audit.js'
import type {
  LlmCallAuditEntry,
  LlmCallAuditSink,
} from '../observability/llm-call-audit.js'
import {
  SharedWorkspace,
  type WorkspaceSubscriber,
} from '../orchestration/team/team-workspace.js'

/**
 * Drains the microtask queue. Ten turns is far more than any path exercised
 * here needs; the point is to give a hypothetical *non*-awaiting implementation
 * every chance to settle before a test asserts that it has not.
 *
 * Real timers are deliberately avoided: `no-restricted-syntax` makes a real
 * `setTimeout` an ERROR in a non-baselined test file such as this one.
 */
async function flushMicrotasks(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve()
  }
}

/**
 * Drains the macrotask queue via `setImmediate`, which the `setTimeout` ban
 * does not cover (its selector is `callee.name='setTimeout'`). Needed because
 * Node only reports an unhandled rejection *after* a full microtask drain, so
 * a purely microtask-based flush cannot observe one.
 */
async function drainMacrotasks(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
}

/**
 * A promise plus the handle that settles it, so a supplied callback can be
 * parked open-endedly and released on demand.
 *
 * This is what makes the await-drop locks below real, and it is NOT
 * interchangeable with a plain `await Promise.resolve()` in the callback.
 * Under that naive swap the mutant and the original produce the *identical*
 * microtask ordering — with the production `await` dropped, the callback's
 * continuation still lands before the test's own `await` resumes — so the
 * assertion holds in both worlds and the lock is vacuous. A gate that stays
 * shut until the test opens it cannot be beaten by microtask luck.
 */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** Minimal stateful MailboxStore double. */
function createStore(): MailboxStore {
  const saved: MailMessage[] = []
  return {
    save(message: MailMessage): Promise<void> {
      saved.push(message)
      return Promise.resolve()
    },
    findByRecipient(agentId: string, _query?: MailboxQuery): Promise<MailMessage[]> {
      return Promise.resolve(saved.filter((m) => m.to === agentId))
    },
    markRead(_messageId: string): Promise<void> {
      return Promise.resolve()
    },
    deleteExpired(): Promise<number> {
      return Promise.resolve(0)
    },
  }
}

function mailMessage(overrides?: Partial<MailMessage>): MailMessage {
  return {
    id: 'msg-1',
    from: 'agent-b',
    to: 'agent-a',
    subject: 'hello',
    body: {},
    createdAt: 0,
    ...overrides,
  }
}

function auditEntry(overrides?: Partial<LlmCallAuditEntry>): LlmCallAuditEntry {
  return {
    agentId: 'a1',
    model: 'test-model',
    inputTokens: 1,
    outputTokens: 2,
    durationMs: 3,
    timestamp: 0,
    success: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// SITE 1 — ApprovalConfig.webhookDLQ  (=> unknown, because the gate awaits it)
// ---------------------------------------------------------------------------

describe('union-return lock: ApprovalConfig.webhookDLQ', () => {
  it('accepts an expression-bodied DLQ assigned through the exported config type', () => {
    const seen: string[] = []

    // TS2322 under `=> void | Promise<void>`: the body evaluates to `number`.
    // The annotation is the PORT (`ApprovalConfig`), so the parameters are
    // contextually typed by the declaration under test rather than by hand.
    const config: ApprovalConfig = {
      mode: 'required',
      webhookDLQ: (runId, webhookUrl, error) =>
        seen.push(`${runId}|${webhookUrl}|${error.message}`),
    }

    config.webhookDLQ?.('r1', 'https://example.com/wh', new Error('boom'))

    expect(seen).toEqual(['r1|https://example.com/wh|boom'])
  })

  it('accepts an expression-bodied DLQ supplied inline to the ApprovalGate constructor', () => {
    const seen: string[] = []
    const bus = createEventBus()

    // TS2322 under `=> void | Promise<void>`: the body evaluates to `number`.
    const gate = new ApprovalGate(
      {
        mode: 'required',
        webhookUrl: 'https://example.com/wh',
        webhookDLQ: (runId) => seen.push(runId),
      },
      bus,
    )

    expect(gate).toBeInstanceOf(ApprovalGate)
  })

  it('still swallows an async DLQ rejection instead of orphaning it (await-drop lock)', async () => {
    vi.useFakeTimers()
    const bus = createEventBus()
    // eslint-disable-next-line no-restricted-globals -- stubbing, not calling, the global
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)

    try {
      const gate = new ApprovalGate(
        {
          mode: 'required',
          timeoutMs: 50,
          webhookUrl: 'https://example.com/wh',
          webhookDLQ: async () => {
            await Promise.resolve()
            throw new Error('DLQ sink down')
          },
        },
        bus,
      )

      const waitPromise = gate.waitForApproval('run-dlq', 'plan')
      await vi.runAllTimersAsync()
      await expect(waitPromise).resolves.toBe('timeout')

      // THE LOCK: `notifyWebhook` discards its own promise, so the ONLY thing
      // standing between a rejecting DLQ and a process-level unhandled
      // rejection is the `await` in front of `this.config.webhookDLQ(...)` —
      // its try/catch can only see a rejection it awaited. Replace that
      // `await` with `void` and the rejected promise is orphaned and surfaces
      // here. Node reports unhandled rejections only after a full microtask
      // drain, hence the macrotask turns.
      vi.useRealTimers()
      await drainMacrotasks()

      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

// ---------------------------------------------------------------------------
// SITES 2 + 3 — AgentMailbox.subscribe / AgentMailboxImpl.subscribe (=> void)
// ---------------------------------------------------------------------------

describe('union-return lock: mailbox subscribe handler', () => {
  it('accepts an expression-bodied handler through the AgentMailbox interface', () => {
    const seen: MailMessage[] = []
    const bus = createEventBus()
    // Annotated as the INTERFACE, so this call resolves against the
    // declaration in mailbox/types.ts (site 2), not the class's own.
    const box: AgentMailbox = new AgentMailboxImpl('agent-a', createStore(), bus)

    // TS2322 under `=> void | Promise<void>`: the body evaluates to `number`.
    box.subscribe((message) => seen.push(message))
    bus.emit({ type: 'mail:received', message: mailMessage() })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.subject).toBe('hello')
  })

  it('accepts an expression-bodied handler through the AgentMailboxImpl class', () => {
    const seen: string[] = []
    const bus = createEventBus()
    // Unannotated, so this call resolves against the class's own method
    // declaration in mailbox/agent-mailbox.ts (site 3).
    const mailbox = new AgentMailboxImpl('agent-a', createStore(), bus)

    // TS2322 under `=> void | Promise<void>`: the body evaluates to `number`.
    mailbox.subscribe((message) => seen.push(message.id))
    bus.emit({ type: 'mail:received', message: mailMessage({ id: 'msg-42' }) })

    expect(seen).toEqual(['msg-42'])
  })

  it('still delivers to an async handler after the narrowing', async () => {
    const seen: string[] = []
    const bus = createEventBus()
    const mailbox = new AgentMailboxImpl('agent-a', createStore(), bus)

    mailbox.subscribe(async (message) => {
      await Promise.resolve()
      seen.push(message.id)
    })
    bus.emit({ type: 'mail:received', message: mailMessage({ id: 'msg-async' }) })

    // Delivery is deliberately fire-and-forget — nothing awaits the handler,
    // which is exactly why this seam is `=> void` and NOT `=> unknown`. Drain
    // the handler's continuation rather than claiming emit() waited for it.
    await flushMicrotasks()

    expect(seen).toEqual(['msg-async'])
  })

  it('still routes an async handler rejection to mail:handler_failed after the narrowing', async () => {
    const failures: DzupEvent[] = []
    const bus = createEventBus()
    bus.on('mail:handler_failed', (event) => {
      failures.push(event)
    })
    const mailbox = new AgentMailboxImpl('agent-a', createStore(), bus)

    mailbox.subscribe(async () => {
      await Promise.resolve()
      throw new Error('handler boom')
    })
    bus.emit({ type: 'mail:received', message: mailMessage() })
    await flushMicrotasks()

    expect(failures).toHaveLength(1)
    const failure = failures[0]
    if (failure?.type === 'mail:handler_failed') {
      expect(failure.agentId).toBe('agent-a')
      expect(failure.error).toContain('handler boom')
    }
  })
})

// ---------------------------------------------------------------------------
// SITE 4 — LlmCallAuditSink.record  (=> unknown, because recordAuditEntry awaits)
// ---------------------------------------------------------------------------

describe('union-return lock: LlmCallAuditSink.record', () => {
  it('accepts an expression-bodied sink assigned through the exported port type', async () => {
    const recorded: LlmCallAuditEntry[] = []

    // TS2322 under `=> void | Promise<void>`: the body evaluates to `number`.
    const sink: LlmCallAuditSink = {
      record: (entry) => recorded.push(entry),
    }

    await recordAuditEntry(sink, auditEntry({ model: 'm-expr' }), {
      agentId: 'a1',
      redactionMode: 'secrets-and-pii',
    })

    expect(recorded.map((e) => e.model)).toEqual(['m-expr'])
  })

  it('still awaits an async sink after the narrowing (await-drop lock)', async () => {
    const recorded: LlmCallAuditEntry[] = []
    const gate = deferred()

    const sink: LlmCallAuditSink = {
      record: async (entry) => {
        await gate.promise
        recorded.push(entry)
      },
    }

    let settled = false
    const pending = recordAuditEntry(sink, auditEntry(), {
      agentId: 'a1',
      redactionMode: 'secrets-and-pii',
    }).then(() => {
      settled = true
    })

    // THE LOCK: the sink is parked on a gate the test has not opened, so a
    // recordAuditEntry() that awaits it cannot possibly have settled — however
    // long we drain. Replace `await sink.record(entry)` with `void
    // sink.record(entry)` and it falls straight out of its try block and
    // settles right here.
    await flushMicrotasks()
    expect(settled).toBe(false)
    expect(recorded).toHaveLength(0)

    gate.release()
    await pending

    expect(settled).toBe(true)
    expect(recorded).toHaveLength(1)
  })

  it('emits audit:sink_failure when an async sink REJECTS after the narrowing', async () => {
    const bus = createEventBus()
    const events: DzupEvent[] = []
    bus.onAny((event) => events.push(event))

    // Every pre-existing audit-sink failure test throws SYNCHRONOUSLY, so the
    // asynchronous rejection arm of `await sink.record(entry)` was untested.
    const sink: LlmCallAuditSink = {
      record: async () => {
        await Promise.resolve()
        throw new Error('sink offline')
      },
    }

    await recordAuditEntry(sink, auditEntry(), {
      eventBus: bus,
      agentId: 'a1',
      runId: 'r1',
      redactionMode: 'secrets-and-pii',
    })

    const failure = events.find((event) => event.type === 'audit:sink_failure')
    expect(failure).toBeDefined()
    if (failure?.type === 'audit:sink_failure') {
      expect(failure.sink).toBe('llm-call-audit')
      expect(failure.agentId).toBe('a1')
      expect(failure.runId).toBe('r1')
      expect(failure.message).toContain('sink offline')
    }
  })
})

// ---------------------------------------------------------------------------
// SITE 5 — WorkspaceSubscriber  (=> unknown; `void` is a hard TS1345)
// ---------------------------------------------------------------------------

describe('union-return lock: WorkspaceSubscriber', () => {
  it('accepts an expression-bodied subscriber assigned to the exported type', async () => {
    const seen: string[] = []

    // TS2322 under `=> void | Promise<void>`: the body evaluates to `number`.
    const subscriber: WorkspaceSubscriber = (key, value) => seen.push(`${key}=${value}`)

    const workspace = new SharedWorkspace()
    workspace.subscribe('plan', subscriber)
    await workspace.set('plan', 'v1')

    expect(seen).toEqual(['plan=v1'])
  })

  it('accepts expression-bodied subscribers supplied inline to subscribe/subscribeAll', async () => {
    const keyed: string[] = []
    const global: string[] = []
    const workspace = new SharedWorkspace()

    // TS2322 under `=> void | Promise<void>`: both bodies evaluate to `number`.
    workspace.subscribe('plan', (key, value) => keyed.push(`${key}=${value}`))
    workspace.subscribeAll((key) => global.push(key))

    await workspace.set('plan', 'v1')
    await workspace.set('other', 'v2')

    expect(keyed).toEqual(['plan=v1'])
    expect(global).toEqual(['plan', 'other'])
  })

  it('still awaits an async subscriber after the narrowing (await-drop lock)', async () => {
    const seen: string[] = []
    const gate = deferred()
    const workspace = new SharedWorkspace()

    workspace.subscribeAll(async (key) => {
      await gate.promise
      seen.push(key)
    })

    let settled = false
    const write = workspace.set('plan', 'v1').then(() => {
      settled = true
    })

    // THE LOCK: the subscriber is parked on a gate the test has not opened, so
    // a set() that awaits its notification cannot possibly have settled.
    // Drop the `await` in notifySubscribers and the write queue drains
    // straight through and set() settles right here.
    await flushMicrotasks()
    expect(settled).toBe(false)
    expect(seen).toHaveLength(0)

    gate.release()
    await write

    expect(settled).toBe(true)
    expect(seen).toEqual(['plan'])
  })

  it('still treats an async subscriber rejection as non-fatal after the narrowing', async () => {
    const workspace = new SharedWorkspace()

    workspace.subscribeAll(async () => {
      await Promise.resolve()
      throw new Error('subscriber boom')
    })

    await expect(workspace.set('plan', 'v1')).resolves.toBeUndefined()
    expect(workspace.get('plan')).toBe('v1')
  })
})
