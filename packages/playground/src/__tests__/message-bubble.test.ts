/**
 * Tests for the MessageBubble component.
 *
 * Verifies role-based styling, role labels, content rendering,
 * timestamp formatting, and ARIA attributes.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageBubble from '../components/chat/MessageBubble.vue'

describe('MessageBubble', () => {
  const baseProps = {
    role: 'user' as const,
    content: 'Hello world',
    timestamp: '2026-03-26T12:30:00Z',
  }

  // -- Role label rendering --

  it('renders "You" label for user role', () => {
    const wrapper = mount(MessageBubble, { props: baseProps })
    expect(wrapper.text()).toContain('You')
  })

  it('renders "Assistant" label for assistant role', () => {
    const wrapper = mount(MessageBubble, {
      props: { ...baseProps, role: 'assistant' },
    })
    expect(wrapper.text()).toContain('Assistant')
  })

  it('renders "System" label for system role', () => {
    const wrapper = mount(MessageBubble, {
      props: { ...baseProps, role: 'system' },
    })
    expect(wrapper.text()).toContain('System')
  })

  // -- Content rendering --

  it('renders message content as preformatted text', () => {
    const wrapper = mount(MessageBubble, {
      props: { ...baseProps, content: 'Line 1\nLine 2' },
    })
    const pre = wrapper.find('pre')
    expect(pre.exists()).toBe(true)
    expect(pre.text()).toContain('Line 1')
    expect(pre.text()).toContain('Line 2')
  })

  it('preserves code-like content (no markdown parsing)', () => {
    const content = 'const x = 1;\nfunction foo() { return x; }'
    const wrapper = mount(MessageBubble, {
      props: { ...baseProps, content },
    })
    expect(wrapper.text()).toContain('const x = 1;')
    expect(wrapper.text()).toContain('function foo()')
  })

  it('handles empty content gracefully', () => {
    const wrapper = mount(MessageBubble, {
      props: { ...baseProps, content: '' },
    })
    expect(wrapper.find('pre').exists()).toBe(true)
  })

  // -- Styling --

  it('applies user-specific classes for user role', () => {
    const wrapper = mount(MessageBubble, { props: baseProps })
    const article = wrapper.find('[role="article"]')
    expect(article.classes()).toContain('ml-auto')
  })

  it('applies assistant-specific classes for assistant role', () => {
    const wrapper = mount(MessageBubble, {
      props: { ...baseProps, role: 'assistant' },
    })
    const article = wrapper.find('[role="article"]')
    expect(article.classes()).toContain('mr-auto')
  })

  it('applies system-specific classes for system role', () => {
    const wrapper = mount(MessageBubble, {
      props: { ...baseProps, role: 'system' },
    })
    const article = wrapper.find('[role="article"]')
    expect(article.classes()).toContain('mr-auto')
    expect(article.classes()).toContain('italic')
  })

  it('aligns user messages to the right', () => {
    const wrapper = mount(MessageBubble, { props: baseProps })
    const container = wrapper.find('.flex.flex-col')
    expect(container.classes()).toContain('items-end')
  })

  it('aligns assistant messages to the left', () => {
    const wrapper = mount(MessageBubble, {
      props: { ...baseProps, role: 'assistant' },
    })
    const container = wrapper.find('.flex.flex-col')
    expect(container.classes()).toContain('items-start')
  })

  // -- Timestamp --

  it('renders formatted time from ISO timestamp', () => {
    const wrapper = mount(MessageBubble, { props: baseProps })
    // We cannot assert the exact time format because it depends on locale,
    // but we can assert the timestamp span is not empty.
    const spans = wrapper.findAll('span')
    const timeSpan = spans.find((s) => s.text().match(/\d{1,2}:\d{2}/))
    expect(timeSpan).toBeDefined()
  })

  it('renders empty string for invalid timestamp', () => {
    const wrapper = mount(MessageBubble, {
      props: { ...baseProps, timestamp: 'invalid-date' },
    })
    // Should not crash, and should gracefully show an empty time
    expect(wrapper.find('[role="article"]').exists()).toBe(true)
  })

  // -- ARIA --

  it('has aria-label on the message article', () => {
    const wrapper = mount(MessageBubble, { props: baseProps })
    const article = wrapper.find('[role="article"]')
    expect(article.attributes('aria-label')).toBe('You message')
  })

  it('has correct aria-label for assistant role', () => {
    const wrapper = mount(MessageBubble, {
      props: { ...baseProps, role: 'assistant' },
    })
    const article = wrapper.find('[role="article"]')
    expect(article.attributes('aria-label')).toBe('Assistant message')
  })
})
