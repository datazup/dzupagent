/**
 * Tests for the MessageList component.
 *
 * Verifies empty state, message rendering, ARIA attributes,
 * and scroll behavior.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageList from '../components/chat/MessageList.vue'
import type { ChatMessage } from '../types.js'

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: 'Test message',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe('MessageList', () => {
  it('shows empty state when no messages', () => {
    const wrapper = mount(MessageList, {
      props: { messages: [] },
    })
    expect(wrapper.text()).toContain('No conversation yet')
  })

  it('shows helpful description in empty state', () => {
    const wrapper = mount(MessageList, {
      props: { messages: [] },
    })
    expect(wrapper.text()).toContain('Choose an agent')
  })

  it('renders messages when provided', () => {
    const messages = [
      makeMessage({ content: 'Hello from user', role: 'user' }),
      makeMessage({ content: 'Hello from assistant', role: 'assistant' }),
    ]
    const wrapper = mount(MessageList, {
      props: { messages },
    })
    expect(wrapper.text()).toContain('Hello from user')
    expect(wrapper.text()).toContain('Hello from assistant')
    expect(wrapper.text()).not.toContain('No conversation yet')
  })

  it('renders one MessageBubble per message', () => {
    const messages = [
      makeMessage({ id: 'a' }),
      makeMessage({ id: 'b' }),
      makeMessage({ id: 'c' }),
    ]
    const wrapper = mount(MessageList, {
      props: { messages },
    })
    const bubbles = wrapper.findAll('[role="article"]')
    expect(bubbles).toHaveLength(3)
  })

  it('has role="log" on the scroll container', () => {
    const wrapper = mount(MessageList, {
      props: { messages: [] },
    })
    const container = wrapper.find('[role="log"]')
    expect(container.exists()).toBe(true)
  })

  it('has aria-label on the scroll container', () => {
    const wrapper = mount(MessageList, {
      props: { messages: [] },
    })
    const container = wrapper.find('[role="log"]')
    expect(container.attributes('aria-label')).toBe('Chat messages')
  })

  it('has aria-live="polite" for screen readers', () => {
    const wrapper = mount(MessageList, {
      props: { messages: [] },
    })
    const container = wrapper.find('[role="log"]')
    expect(container.attributes('aria-live')).toBe('polite')
  })

  it('renders messages with different roles', () => {
    const messages = [
      makeMessage({ role: 'user', content: 'User says' }),
      makeMessage({ role: 'assistant', content: 'Assistant says' }),
      makeMessage({ role: 'system', content: 'System says' }),
    ]
    const wrapper = mount(MessageList, {
      props: { messages },
    })
    expect(wrapper.text()).toContain('You')
    expect(wrapper.text()).toContain('Assistant')
    expect(wrapper.text()).toContain('System')
  })
})
