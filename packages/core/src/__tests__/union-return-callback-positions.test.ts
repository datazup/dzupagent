/**
 * Union-return sweep — type-level lock for supplied-callback positions.
 *
 * TypeScript's void-returning-function leniency lets a callback that returns a
 * value satisfy a `=> void` position: `(e) => seen.push(e)` returns `number`,
 * yet is assignable to `(e: E) => void`. That leniency does NOT survive a
 * union — under `=> void | Promise<void>` the same expression-bodied arrow is
 * rejected with TS2322 ("Type 'number' is not assignable to type
 * 'void | Promise<void>'"). So `=> void | Promise<void>`, which authors write
 * intending to be *more* permissive, is strictly *less* permissive for
 * consumers. Plain `=> void` already accepts both `() => {}` and `async () => {}`.
 *
 * Every callback below is deliberately EXPRESSION-BODIED over an `Array.push`
 * so its body evaluates to `number`. Each one fails to compile if its
 * declaration is widened back to `void | Promise<void>`.
 *
 * This is a TYPE-level lock: vitest does not typecheck, so the guard that
 * actually enforces it is `tsc -p tsconfig.flipcheck.json` (the
 * `scripts/check-test-typecheck.mjs` gate), which includes `__tests__`.
 * The runtime assertions below additionally prove the narrowing did not break
 * async handling — async callbacks are still awaited, and their rejections are
 * still caught.
 *
 * Sites pinned:
 *   1. plugin/plugin-types.ts      DzupPlugin.onRegister
 *   2. plugin/plugin-types.ts      DzupPlugin.eventHandlers
 *   3. events/agent-bus.ts         AgentMessageHandler
 *   4. tools/tool-governance.ts    ToolAuditHandler.onToolCall
 *   5. tools/tool-governance.ts    ToolAuditHandler.onToolResult
 */

import { describe, it, expect } from 'vitest'
import { PluginRegistry } from '../plugin/plugin-registry.js'
import type { DzupPlugin, PluginContext } from '../plugin/plugin-types.js'
import { createEventBus } from '../events/event-bus.js'
import type { DzupEventBus } from '../events/event-bus.js'
import type { DzupEvent } from '../events/event-types.js'
import type { ModelRegistry } from '../llm/model-registry.js'
import { AgentBus } from '../events/agent-bus.js'
import type { AgentMessage, AgentMessageHandler } from '../events/agent-bus.js'
import { ToolGovernance } from '../tools/tool-governance.js'
import type {
  ToolAuditEntry,
  ToolAuditHandler,
  ToolGovernanceConfig,
  ToolResultAuditEntry,
} from '../tools/tool-governance.js'

function stubContext(eventBus: DzupEventBus): PluginContext {
  return { eventBus, modelRegistry: {} as unknown as ModelRegistry }
}

function auditEntry(toolName: string): ToolAuditEntry {
  return {
    toolName,
    input: {},
    callerAgent: 'a1',
    timestamp: 0,
    allowed: true,
  }
}

function resultEntry(toolName: string): ToolResultAuditEntry {
  return {
    toolName,
    output: 'ok',
    callerAgent: 'a1',
    durationMs: 1,
    success: true,
    timestamp: 0,
  }
}

// ---------------------------------------------------------------------------
// SITE 1 — DzupPlugin.onRegister
// ---------------------------------------------------------------------------

describe('union-return lock: DzupPlugin.onRegister', () => {
  it('accepts an expression-bodied onRegister supplied through the public type', async () => {
    const seen: PluginContext[] = []

    // TS2322 under `=> void | Promise<void>`: the body evaluates to `number`.
    const plugin: DzupPlugin = {
      name: 'expr-onregister',
      version: '1.0.0',
      onRegister: (ctx) => seen.push(ctx),
    }

    const bus = createEventBus()
    const ctx = stubContext(bus)
    await new PluginRegistry(bus).register(plugin, ctx)

    expect(seen).toEqual([ctx])
  })

  it('still awaits an async onRegister after the narrowing', async () => {
    const order: string[] = []

    const plugin: DzupPlugin = {
      name: 'async-onregister',
      version: '1.0.0',
      onRegister: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push('onRegister')
      },
    }

    const bus = createEventBus()
    await new PluginRegistry(bus).register(plugin, stubContext(bus))
    order.push('after-register')

    // If `await` were dropped, 'after-register' would land first.
    expect(order).toEqual(['onRegister', 'after-register'])
  })

  it('still propagates an async onRegister rejection after the narrowing', async () => {
    const plugin: DzupPlugin = {
      name: 'rejecting-onregister',
      version: '1.0.0',
      onRegister: async () => {
        await Promise.resolve()
        throw new Error('boom')
      },
    }

    const bus = createEventBus()
    const registry = new PluginRegistry(bus)
    await expect(registry.register(plugin, stubContext(bus))).rejects.toThrow('boom')
    expect(registry.has('rejecting-onregister')).toBe(false)
  })

  it('keeps `this` bound when onRegister is written as a method', async () => {
    const seen: string[] = []

    const plugin: DzupPlugin = {
      name: 'method-onregister',
      version: '1.0.0',
      onRegister(this: DzupPlugin) {
        // Would throw on an undefined `this` if the registry called the
        // callback detached from the plugin object.
        seen.push(this.name)
      },
    }

    const bus = createEventBus()
    await new PluginRegistry(bus).register(plugin, stubContext(bus))

    expect(seen).toEqual(['method-onregister'])
  })
})

// ---------------------------------------------------------------------------
// SITE 2 — DzupPlugin.eventHandlers
// ---------------------------------------------------------------------------

describe('union-return lock: DzupPlugin.eventHandlers', () => {
  it('accepts an expression-bodied event handler supplied through the public type', async () => {
    const seen: DzupEvent[] = []

    // TS2322 under `=> void | Promise<void>`: the body evaluates to `number`.
    const plugin: DzupPlugin = {
      name: 'expr-eventhandlers',
      version: '1.0.0',
      eventHandlers: {
        'agent:started': (event) => seen.push(event),
      },
    }

    const bus = createEventBus()
    await new PluginRegistry(bus).register(plugin, stubContext(bus))
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.type).toBe('agent:started')
  })

  it('still accepts an async event handler after the narrowing', async () => {
    const seen: string[] = []

    const plugin: DzupPlugin = {
      name: 'async-eventhandlers',
      version: '1.0.0',
      eventHandlers: {
        'agent:started': async (event) => {
          await Promise.resolve()
          seen.push(event.type)
        },
      },
    }

    const bus = createEventBus()
    await new PluginRegistry(bus).register(plugin, stubContext(bus))
    bus.emit({ type: 'agent:started', agentId: 'a1', runId: 'r1' })
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(seen).toEqual(['agent:started'])
  })
})

// ---------------------------------------------------------------------------
// SITE 3 — AgentMessageHandler
// ---------------------------------------------------------------------------

describe('union-return lock: AgentMessageHandler', () => {
  it('accepts an expression-bodied handler assigned to the exported type', () => {
    const seen: AgentMessage[] = []

    // TS2322 under `=> void | Promise<void>`: the body evaluates to `number`.
    const handler: AgentMessageHandler = (message) => seen.push(message)

    handler({ from: 'a', channel: 'c', payload: {}, timestamp: 0 })

    expect(seen).toHaveLength(1)
  })

  it('accepts an expression-bodied handler through AgentBus.subscribe', () => {
    const seen: AgentMessage[] = []
    const bus = new AgentBus()

    // TS2322 under `=> void | Promise<void>`: the body evaluates to `number`.
    bus.subscribe('code-changes', 'agent-b', (message) => seen.push(message))
    bus.publish('agent-a', 'code-changes', { files: ['auth.ts'] })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.payload).toEqual({ files: ['auth.ts'] })
  })

  it('still catches async handler rejections after the narrowing', async () => {
    const bus = new AgentBus()

    bus.subscribe('c', 'rejecting', async () => {
      await Promise.resolve()
      throw new Error('async handler boom')
    })

    // The rejection is caught inside publish(); an unhandled rejection here
    // would fail the run rather than return normally.
    expect(() => { bus.publish('a', 'c', {}) }).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
})

// ---------------------------------------------------------------------------
// SITES 4 + 5 — ToolAuditHandler.onToolCall / onToolResult
// ---------------------------------------------------------------------------

describe('union-return lock: ToolAuditHandler', () => {
  it('accepts expression-bodied audit sinks assigned to the exported type', async () => {
    const calls: ToolAuditEntry[] = []
    const results: ToolResultAuditEntry[] = []

    // TS2322 under `=> void | Promise<void>`: both bodies evaluate to `number`.
    const auditHandler: ToolAuditHandler = {
      onToolCall: (entry) => calls.push(entry),
      onToolResult: (entry) => results.push(entry),
    }

    const gov = new ToolGovernance({ auditHandler })
    await gov.audit(auditEntry('read_file'))
    await gov.auditResult(resultEntry('read_file'))

    expect(calls.map((c) => c.toolName)).toEqual(['read_file'])
    expect(results.map((r) => r.toolName)).toEqual(['read_file'])
  })

  it('accepts expression-bodied audit sinks supplied inline via ToolGovernanceConfig', async () => {
    const calls: string[] = []
    const results: string[] = []

    // TS2322 under `=> void | Promise<void>`: both bodies evaluate to `number`.
    const config: ToolGovernanceConfig = {
      auditHandler: {
        onToolCall: (entry) => calls.push(entry.toolName),
        onToolResult: (entry) => results.push(entry.toolName),
      },
    }

    const gov = new ToolGovernance(config)
    await gov.audit(auditEntry('write_file'))
    await gov.auditResult(resultEntry('write_file'))

    expect(calls).toEqual(['write_file'])
    expect(results).toEqual(['write_file'])
  })

  it('still awaits async audit sinks after the narrowing', async () => {
    const order: string[] = []

    const gov = new ToolGovernance({
      auditHandler: {
        onToolCall: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          order.push('onToolCall')
        },
      },
    })

    await gov.audit(auditEntry('slow'))
    order.push('after-audit')

    // If `await` were dropped, 'after-audit' would land first.
    expect(order).toEqual(['onToolCall', 'after-audit'])
  })

  it('still swallows async audit-sink rejections after the narrowing', async () => {
    const gov = new ToolGovernance({
      auditHandler: {
        onToolCall: async () => {
          await Promise.resolve()
          throw new Error('sink down')
        },
        onToolResult: async () => {
          await Promise.resolve()
          throw new Error('sink down')
        },
      },
    })

    // Audit failures are non-fatal: the rejection must be caught, not escape.
    await expect(gov.audit(auditEntry('t'))).resolves.toBeUndefined()
    await expect(gov.auditResult(resultEntry('t'))).resolves.toBeUndefined()
  })

  it('keeps `this` bound when audit sinks are written as methods', async () => {
    const seen: string[] = []

    const auditHandler: ToolAuditHandler = {
      label: 'sink-1',
      onToolCall(this: ToolAuditHandler & { label: string }) {
        // Would throw on an undefined `this` if ToolGovernance called the
        // sink detached from the handler object.
        seen.push(this.label)
      },
    } as ToolAuditHandler & { label: string }

    const gov = new ToolGovernance({ auditHandler })
    await gov.audit(auditEntry('t'))

    expect(seen).toEqual(['sink-1'])
  })
})
