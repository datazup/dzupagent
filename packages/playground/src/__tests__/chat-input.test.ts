/**
 * Tests for the ChatInput component.
 *
 * Covers send behavior, keyboard shortcuts, disabled/loading states,
 * placeholder text, and button labeling.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatInput from '../components/chat/ChatInput.vue'

describe('ChatInput', () => {
  function mountInput(props: Record<string, unknown> = {}) {
    return mount(ChatInput, { props })
  }

  // -- Rendering --

  it('renders a textarea with default placeholder', () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)
    expect((textarea.element as HTMLTextAreaElement).placeholder).toContain('Type a message')
  })

  it('renders custom placeholder when provided', () => {
    const wrapper = mountInput({ placeholder: 'Say something...' })
    const textarea = wrapper.find('textarea')
    expect((textarea.element as HTMLTextAreaElement).placeholder).toBe('Say something...')
  })

  it('renders a Send button', () => {
    const wrapper = mountInput()
    const btn = wrapper.find('button[aria-label="Send message"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toBe('Send')
  })

  it('shows "Sending..." text when loading', () => {
    const wrapper = mountInput({ loading: true })
    const btn = wrapper.find('button[aria-label="Send message"]')
    expect(btn.text()).toBe('Sending...')
  })

  // -- Disabled states --

  it('disables textarea and button when disabled prop is true', () => {
    const wrapper = mountInput({ disabled: true })
    const textarea = wrapper.find('textarea')
    const btn = wrapper.find('button[aria-label="Send message"]')
    expect((textarea.element as HTMLTextAreaElement).disabled).toBe(true)
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables textarea and button when loading prop is true', () => {
    const wrapper = mountInput({ loading: true })
    const textarea = wrapper.find('textarea')
    expect((textarea.element as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('disables send button when input is empty', () => {
    const wrapper = mountInput()
    const btn = wrapper.find('button[aria-label="Send message"]')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
  })

  // -- Send behavior --

  it('emits send event with trimmed content on button click', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('  Hello world  ')
    const btn = wrapper.find('button[aria-label="Send message"]')
    await btn.trigger('click')

    expect(wrapper.emitted('send')).toHaveLength(1)
    expect(wrapper.emitted('send')![0]).toEqual(['Hello world'])
  })

  it('clears the input after sending', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('Hello')
    await wrapper.find('button[aria-label="Send message"]').trigger('click')

    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  })

  it('does not emit send when input is whitespace only', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('   ')
    await wrapper.find('button[aria-label="Send message"]').trigger('click')

    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('emits send on Enter key (without Shift)', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('Hello')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false })

    expect(wrapper.emitted('send')).toHaveLength(1)
    expect(wrapper.emitted('send')![0]).toEqual(['Hello'])
  })

  it('does not emit send on Shift+Enter (allows newline)', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('Hello')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })

    expect(wrapper.emitted('send')).toBeUndefined()
  })

  // -- ARIA --

  it('has aria-label on the textarea', () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    expect(textarea.attributes('aria-label')).toBe('Chat message input')
  })

  // -- Keyboard hint --

  it('shows keyboard shortcut hint', () => {
    const wrapper = mountInput()
    expect(wrapper.text()).toContain('Enter')
    expect(wrapper.text()).toContain('Shift + Enter')
  })
})
