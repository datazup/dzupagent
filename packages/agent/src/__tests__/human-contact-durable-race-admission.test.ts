import { describe, expect, it, vi } from 'vitest'

import {
  createHumanContactTool,
  humanContactRunnableConfig,
  InMemoryPendingContactStore,
} from '../tools/human-contact-tool.js'

describe('human-contact durable reservation admission', () => {
  it('grants one pause owner when two creators race the same invocation', async () => {
    const pendingStore = new InMemoryPendingContactStore()
    let releasePause!: () => void
    const pauseGate = new Promise<void>((resolve) => { releasePause = resolve })
    const onPause = vi.fn(async () => pauseGate)
    const contact = createHumanContactTool({ pendingStore, onPause })
    const context = humanContactRunnableConfig({
      runId: 'run-racing-creators',
      tenantId: 'tenant-racing-creators',
      invocationId: 'invocation-racing-creators',
    })

    const first = contact.invoke({ mode: 'approval', question: 'redacted' }, context)
    const second = contact.invoke({ mode: 'approval', question: 'redacted' }, context)
    const bothSettled = Promise.allSettled([first, second])
    await vi.waitFor(() => expect(onPause).toHaveBeenCalledTimes(1))
    releasePause()

    const settled = await bothSettled
    expect(onPause).toHaveBeenCalledTimes(1)
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(String(
      (settled.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
    )).toContain('HUMAN_CONTACT_PAUSE_IN_PROGRESS')
  })
})
