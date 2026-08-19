import { tool } from '@langchain/core/tools'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { invokeToolWithRetry } from '../agent/tool-loop/tool-invoker.js'
import { executeStreamingToolCall } from '../agent/run-engine.js'
import type { ToolLoopConfig } from '../agent/tool-loop.js'
import {
  buildPolicyConfig,
  prepareGuardPrelude,
} from '../agent/run-engine-generate-tool-loop.js'
import { buildStreamingToolPolicy } from '../agent/streaming-run-policy.js'
import type { DzupAgentConfig } from '../agent/agent-types.js'
import type { ExecuteGenerateRunParams } from '../agent/run-engine/types.js'
import type { StreamRunContext } from '../agent/streaming-run-types.js'
import {
  createHumanContactTool,
  humanContactRunnableConfig,
  InMemoryPendingContactStore,
  readHumanContactInvocationContext,
  type HumanContactToolConfig,
  type PendingContactStore,
} from '../tools/human-contact-tool.js'

function toolResponse(raw: unknown): Record<string, unknown> {
  return JSON.parse(String(raw)) as Record<string, unknown>
}

function trackingStore(): PendingContactStore & {
  saves: unknown[]
  gets: string[]
  deletes: string[]
} {
  const contacts = new Map<string, Parameters<PendingContactStore['save']>[0]>()
  return {
    saves: [],
    gets: [],
    deletes: [],
    async create(contact) {
      const contactId = contact.request.contactId
      const existing = contacts.get(contactId)
      if (existing) return { created: false, contact: existing }
      contacts.set(contactId, contact)
      return { created: true, contact }
    },
    async save(contact) {
      this.saves.push(contact)
      contacts.set(contact.request.contactId, contact)
    },
    async get(contactId) {
      this.gets.push(contactId)
      return contacts.get(contactId) ?? null
    },
    async delete(contactId) {
      this.deletes.push(contactId)
      contacts.delete(contactId)
    },
  }
}

describe('human-contact runtime binding H1 admission', () => {
  it('fails before store or pause effects when standalone invocation has no context', async () => {
    const pendingStore = trackingStore()
    const onPause = vi.fn().mockResolvedValue(undefined)
    const contact = createHumanContactTool({ pendingStore, onPause })

    await expect(contact.invoke({ mode: 'approval' })).rejects.toThrow(
      'HUMAN_CONTACT_CONTEXT_REQUIRED',
    )
    expect(pendingStore.saves).toEqual([])
    expect(onPause).not.toHaveBeenCalled()
  })

  it('uses the exact call-local run identity in store, pause, and response path', async () => {
    const pendingStore = trackingStore()
    const onPause = vi.fn().mockResolvedValue(undefined)
    const contact = createHumanContactTool({ pendingStore, onPause })
    const context = {
      runId: 'run-exact-42',
      tenantId: 'tenant-blue',
      invocationId: 'tool-call-7',
      profileKey: 'profile-3',
    }

    const result = toolResponse(
      await contact.invoke(
        { mode: 'approval', question: 'Proceed?' },
        humanContactRunnableConfig(context),
      ),
    )

    expect(pendingStore.saves).toHaveLength(1)
    const saved = pendingStore.saves[0] as {
      request: { runId: string }
    }
    expect(saved.request.runId).toBe(context.runId)
    expect(onPause).toHaveBeenCalledTimes(1)
    expect(onPause.mock.calls[0]?.[1]).toMatchObject({ runId: context.runId })
    expect(result['resumeWith']).toBe(
      `POST /api/runs/${context.runId}/human-contact/${String(result['contactId'])}/respond`,
    )
  })

  it('rejects unsupported explicit channels before persistence or pause', async () => {
    const pendingStore = trackingStore()
    const onPause = vi.fn().mockResolvedValue(undefined)
    const contact = createHumanContactTool({ pendingStore, onPause })

    await expect(
      contact.invoke(
        { mode: 'approval', channel: 'carrier-pigeon' },
        humanContactRunnableConfig({
          runId: 'run-1',
          tenantId: 'tenant-1',
          invocationId: 'call-1',
        }),
      ),
    ).rejects.toThrow()
    expect(pendingStore.saves).toEqual([])
    expect(onPause).not.toHaveBeenCalled()
  })

  it('rejects an unsupported configured default at factory construction', () => {
    expect(() =>
      createHumanContactTool({
        defaultChannel: 'carrier-pigeon',
      } as HumanContactToolConfig),
    ).toThrow('HUMAN_CONTACT_CHANNEL_UNSUPPORTED')
  })

  it('passes the exact context through the sequential tool invoker', async () => {
    const observed: unknown[] = []
    const contextTool = tool(
      async (_input, config) => {
        observed.push(readHumanContactInvocationContext(config))
        return 'ok'
      },
      { name: 'context_probe', description: 'probe', schema: z.object({}) },
    )

    await invokeToolWithRetry({
      tool: contextTool,
      toolName: contextTool.name,
      toolCallId: 'sequential-call',
      validatedArgs: {},
      validatedKeys: [],
      config: {
        maxIterations: 1,
        humanContactContext: {
          runId: 'run-sequential',
          tenantId: 'tenant-sequential',
          profileKey: 'profile-sequential',
        },
      } as ToolLoopConfig,
    })

    expect(observed).toEqual([
      {
        runId: 'run-sequential',
        tenantId: 'tenant-sequential',
        invocationId: 'sequential-call',
        profileKey: 'profile-sequential',
      },
    ])
  })

  it('passes the exact context through the native-stream tool invoker', async () => {
    const observed: unknown[] = []
    const contextTool = tool(
      async (_input, config) => {
        observed.push(readHumanContactInvocationContext(config))
        return 'ok'
      },
      { name: 'context_probe', description: 'probe', schema: z.object({}) },
    )

    await executeStreamingToolCall({
      toolCall: { id: 'stream-call', name: contextTool.name, args: {} },
      toolMap: new Map([[contextTool.name, contextTool]]),
      transformToolResult: async (_name, _input, result) => result,
      statTracker: { record: vi.fn(), toArray: () => [] },
      policy: {
        humanContactContext: {
          runId: 'run-stream',
          tenantId: 'tenant-stream',
        },
      },
    })

    expect(observed).toEqual([
      {
        runId: 'run-stream',
        tenantId: 'tenant-stream',
        invocationId: 'stream-call',
      },
    ])
  })

  it('resolves generate and stream call precedence into the same context', () => {
    const config = {
      id: 'agent-1',
      instructions: 'test',
      model: {} as DzupAgentConfig['model'],
      memoryScope: { tenantId: 'tenant-runtime' },
      toolExecution: { runId: 'run-config-fallback' },
    } satisfies DzupAgentConfig
    const options = {
      runId: 'run-call-wins',
      humanContact: { profileKey: 'profile-runtime' },
    }

    const generatePolicy = buildPolicyConfig(
      { config, options, agentId: config.id } as unknown as ExecuteGenerateRunParams,
      prepareGuardPrelude(config),
    )
    const streamPolicy = buildStreamingToolPolicy(
      { config, agentId: config.id } as unknown as StreamRunContext,
      options,
    )

    const expected = {
      runId: 'run-call-wins',
      tenantId: 'tenant-runtime',
      profileKey: 'profile-runtime',
    }
    expect(generatePolicy.humanContactContext).toEqual(expected)
    expect(streamPolicy?.humanContactContext).toEqual(expected)
  })

  it('keeps explicit channel ahead of the preference resolver', async () => {
    const pendingStore = trackingStore()
    const resolvePreferredChannel = vi.fn().mockResolvedValue('email')
    const contact = createHumanContactTool({
      pendingStore,
      resolvePreferredChannel,
    })

    const result = toolResponse(
      await contact.invoke(
        { mode: 'approval', channel: 'slack' },
        humanContactRunnableConfig({
          runId: 'run-explicit',
          tenantId: 'tenant-explicit',
          invocationId: 'call-explicit',
        }),
      ),
    )

    expect(result['channel']).toBe('slack')
    expect(resolvePreferredChannel).not.toHaveBeenCalled()
  })

  it('uses resolved preference ahead of the configured default with minimal context', async () => {
    const pendingStore = trackingStore()
    const resolvePreferredChannel = vi.fn().mockResolvedValue('slack')
    const contact = createHumanContactTool({
      pendingStore,
      defaultChannel: 'email',
      resolvePreferredChannel,
    })

    const result = toolResponse(
      await contact.invoke(
        { mode: 'clarification', question: 'private question' },
        humanContactRunnableConfig({
          runId: 'run-preference',
          tenantId: 'tenant-preference',
          invocationId: 'call-preference',
          profileKey: 'profile-preference',
        }),
      ),
    )

    expect(result['channel']).toBe('slack')
    expect(resolvePreferredChannel).toHaveBeenCalledWith({
      runId: 'run-preference',
      tenantId: 'tenant-preference',
      profileKey: 'profile-preference',
    })
    expect(resolvePreferredChannel.mock.calls[0]?.[0]).not.toHaveProperty('question')
    expect(resolvePreferredChannel.mock.calls[0]?.[0]).not.toHaveProperty('invocationId')
  })

  it('treats a missing preference as ordinary configured-default fallback', async () => {
    const contact = createHumanContactTool({
      pendingStore: trackingStore(),
      defaultChannel: 'email',
      resolvePreferredChannel: vi.fn().mockResolvedValue(null),
    })

    const result = toolResponse(
      await contact.invoke(
        { mode: 'approval' },
        humanContactRunnableConfig({
          runId: 'run-missing',
          tenantId: 'tenant-missing',
          invocationId: 'call-missing',
        }),
      ),
    )
    expect(result['channel']).toBe('email')
  })

  it('rejects an unsupported resolver result before store or pause effects', async () => {
    const pendingStore = trackingStore()
    const onPause = vi.fn().mockResolvedValue(undefined)
    const contact = createHumanContactTool({
      pendingStore,
      onPause,
      resolvePreferredChannel: vi.fn().mockResolvedValue('carrier-pigeon'),
    } as HumanContactToolConfig)

    await expect(
      contact.invoke(
        { mode: 'approval' },
        humanContactRunnableConfig({
          runId: 'run-invalid-preference',
          tenantId: 'tenant-invalid-preference',
          invocationId: 'call-invalid-preference',
        }),
      ),
    ).rejects.toThrow('HUMAN_CONTACT_CHANNEL_UNSUPPORTED')
    expect(pendingStore.saves).toEqual([])
    expect(onPause).not.toHaveBeenCalled()
  })

  it('fails closed on resolver error without leaking its sensitive message', async () => {
    const pendingStore = trackingStore()
    const onPause = vi.fn().mockResolvedValue(undefined)
    const contact = createHumanContactTool({
      pendingStore,
      onPause,
      resolvePreferredChannel: vi
        .fn()
        .mockRejectedValue(new Error('private-profile-value@example.invalid')),
    })

    await expect(
      contact.invoke(
        { mode: 'approval', question: 'private contact content' },
        humanContactRunnableConfig({
          runId: 'run-resolver-error',
          tenantId: 'tenant-resolver-error',
          invocationId: 'call-resolver-error',
        }),
      ),
    ).rejects.toThrow('HUMAN_CONTACT_PREFERENCE_RESOLUTION_FAILED')
    await expect(
      contact.invoke(
        { mode: 'approval' },
        humanContactRunnableConfig({
          runId: 'run-resolver-error-2',
          tenantId: 'tenant-resolver-error',
          invocationId: 'call-resolver-error-2',
        }),
      ),
    ).rejects.not.toThrow('private-profile-value@example.invalid')
    expect(pendingStore.saves).toEqual([])
    expect(onPause).not.toHaveBeenCalled()
  })

  it('reuses one reservation and pause acknowledgement for duplicate invocation', async () => {
    const pendingStore = new InMemoryPendingContactStore()
    const onPause = vi.fn().mockResolvedValue(undefined)
    const contact = createHumanContactTool({ pendingStore, onPause })
    const runtimeConfig = humanContactRunnableConfig({
      runId: 'run-duplicate',
      tenantId: 'tenant-duplicate',
      invocationId: 'call-duplicate',
    })

    const first = toolResponse(
      await contact.invoke({ mode: 'approval' }, runtimeConfig),
    )
    const second = toolResponse(
      await contact.invoke({ mode: 'approval' }, runtimeConfig),
    )

    expect(second['contactId']).toBe(first['contactId'])
    expect(second).toEqual(first)
    expect(onPause).toHaveBeenCalledTimes(1)
    const stored = await pendingStore.get(String(first['contactId']))
    expect(stored).toMatchObject({
      lifecycleStatus: 'paused',
      tenantId: 'tenant-duplicate',
      invocationId: 'call-duplicate',
    })
  })

  it('hands the opaque resume token only to the pause adapter', async () => {
    const pendingStore = new InMemoryPendingContactStore()
    const onPause = vi.fn().mockResolvedValue(undefined)
    const contact = createHumanContactTool({ pendingStore, onPause })

    const raw = String(
      await contact.invoke(
        { mode: 'clarification', question: 'private' },
        humanContactRunnableConfig({
          runId: 'run-token',
          tenantId: 'tenant-token',
          invocationId: 'call-token',
        }),
      ),
    )
    const result = toolResponse(raw)
    const pauseContext = onPause.mock.calls[0]?.[2] as {
      resumeToken: string
    }

    expect(pauseContext.resumeToken).toEqual(expect.any(String))
    expect(pauseContext.resumeToken.length).toBeGreaterThan(20)
    expect(raw).not.toContain(pauseContext.resumeToken)
    const stored = await pendingStore.get(String(result['contactId']))
    expect(stored?.resumeToken).toBe(pauseContext.resumeToken)
    expect(JSON.stringify(stored?.request)).not.toContain(pauseContext.resumeToken)
  })

  it('retains a terminal failed reservation when pause rejects without leaking cause', async () => {
    const pendingStore = new InMemoryPendingContactStore()
    const onPause = vi
      .fn()
      .mockRejectedValue(new Error('private-pause-target@example.invalid'))
    const contact = createHumanContactTool({ pendingStore, onPause })
    const runtimeConfig = humanContactRunnableConfig({
      runId: 'run-pause-failed',
      tenantId: 'tenant-pause-failed',
      invocationId: 'call-pause-failed',
    })

    await expect(
      contact.invoke({ mode: 'approval' }, runtimeConfig),
    ).rejects.toThrow('HUMAN_CONTACT_PAUSE_FAILED')
    await expect(
      contact.invoke({ mode: 'approval' }, runtimeConfig),
    ).rejects.not.toThrow('private-pause-target@example.invalid')
    expect(onPause).toHaveBeenCalledTimes(1)

    const expectedContactId = onPause.mock.calls[0]?.[0] as string
    expect(await pendingStore.get(expectedContactId)).toMatchObject({
      lifecycleStatus: 'failed',
    })
  })

  it('does not call pause when atomic reservation creation fails', async () => {
    const onPause = vi.fn().mockResolvedValue(undefined)
    const pendingStore = {
      create: vi.fn().mockRejectedValue(new Error('private-store-diagnostic')),
      save: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    } as unknown as PendingContactStore
    const contact = createHumanContactTool({ pendingStore, onPause })

    await expect(
      contact.invoke(
        { mode: 'approval' },
        humanContactRunnableConfig({
          runId: 'run-store-failed',
          tenantId: 'tenant-store-failed',
          invocationId: 'call-store-failed',
        }),
      ),
    ).rejects.toThrow('HUMAN_CONTACT_RESERVATION_FAILED')
    await expect(
      contact.invoke(
        { mode: 'approval' },
        humanContactRunnableConfig({
          runId: 'run-store-failed-2',
          tenantId: 'tenant-store-failed',
          invocationId: 'call-store-failed-2',
        }),
      ),
    ).rejects.not.toThrow('private-store-diagnostic')
    expect(onPause).not.toHaveBeenCalled()
    expect(pendingStore.save).not.toHaveBeenCalled()
  })

  it('keeps a recoverable preparing reservation when pause commit fails', async () => {
    const contacts = new Map<
      string,
      Parameters<PendingContactStore['save']>[0]
    >()
    let rejectPausedCommit = true
    const pendingStore: PendingContactStore = {
      async create(contact) {
        const contactId = contact.request.contactId
        const existing = contacts.get(contactId)
        if (existing) return { created: false, contact: existing }
        contacts.set(contactId, contact)
        return { created: true, contact }
      },
      async save(contact) {
        if (contact.lifecycleStatus === 'paused' && rejectPausedCommit) {
          rejectPausedCommit = false
          throw new Error('private-commit-diagnostic')
        }
        contacts.set(contact.request.contactId, contact)
      },
      async get(contactId) {
        return contacts.get(contactId) ?? null
      },
      async delete(contactId) {
        contacts.delete(contactId)
      },
    }
    const onPause = vi.fn().mockResolvedValue(undefined)
    const contact = createHumanContactTool({ pendingStore, onPause })
    const runtimeConfig = humanContactRunnableConfig({
      runId: 'run-commit-retry',
      tenantId: 'tenant-commit-retry',
      invocationId: 'call-commit-retry',
    })

    await expect(
      contact.invoke({ mode: 'approval' }, runtimeConfig),
    ).rejects.toThrow('HUMAN_CONTACT_PAUSE_COMMIT_FAILED')
    const contactId = onPause.mock.calls[0]?.[0] as string
    expect(await pendingStore.get(contactId)).toMatchObject({
      lifecycleStatus: 'preparing',
    })

    const retried = toolResponse(
      await contact.invoke({ mode: 'approval' }, runtimeConfig),
    )
    expect(retried['contactId']).toBe(contactId)
    expect(onPause).toHaveBeenCalledTimes(2)
    expect(await pendingStore.get(contactId)).toMatchObject({
      lifecycleStatus: 'paused',
    })
  })
})
