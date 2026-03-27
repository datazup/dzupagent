import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ChatPanel from '../components/chat/ChatPanel.vue'
import { useChatStore } from '../stores/chat-store.js'

vi.mock('../composables/useApi.js', () => ({
  useApi: () => ({
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    buildUrl: vi.fn((p: string) => p),
  }),
}))

describe('chat streaming ui', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders assistant stream deltas and final replacement in ChatPanel', async () => {
    const store = useChatStore()
    store.currentAgentId = 'agent-1'
    store.activeRunId = 'run-ui-1'

    const wrapper = mount(ChatPanel)

    store.handleRealtimeEvent({ type: 'agent:stream_delta', runId: 'run-ui-1', content: 'Hello' })
    await nextTick()
    expect(wrapper.text()).toContain('Hello')

    store.handleRealtimeEvent({ type: 'agent:stream_delta', runId: 'run-ui-1', content: ' world' })
    await nextTick()
    expect(wrapper.text()).toContain('Hello world')

    store.handleRealtimeEvent({ type: 'agent:stream_done', runId: 'run-ui-1', finalContent: 'Hello world!' })
    await nextTick()
    expect(wrapper.text()).toContain('Hello world!')
  })
})
