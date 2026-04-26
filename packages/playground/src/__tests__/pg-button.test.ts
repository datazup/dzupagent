/**
 * Tests for the PgButton primitive -- variant + behavior, no brittle CSS
 * string assertions.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PgButton from '../components/ui/PgButton.vue'

describe('PgButton', () => {
  it('renders slot content as the label', () => {
    const wrapper = mount(PgButton, { slots: { default: 'Save' } })
    expect(wrapper.text()).toBe('Save')
  })

  it('defaults to the outline variant', () => {
    const wrapper = mount(PgButton, { slots: { default: 'x' } })
    expect(wrapper.attributes('data-variant')).toBe('outline')
  })

  it('marks the variant via data-variant attribute', () => {
    const wrapper = mount(PgButton, {
      props: { variant: 'accent' },
      slots: { default: 'Run' },
    })
    expect(wrapper.attributes('data-variant')).toBe('accent')
    expect(wrapper.classes()).toContain('pg-btn-accent')
  })

  it('emits click when not disabled', async () => {
    const wrapper = mount(PgButton, { slots: { default: 'Go' } })
    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toBeTruthy()
  })

  it('reflects the disabled prop on the underlying button', () => {
    const wrapper = mount(PgButton, {
      props: { disabled: true },
      slots: { default: 'x' },
    })
    expect((wrapper.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('honors the type prop', () => {
    const wrapper = mount(PgButton, {
      props: { type: 'submit' },
      slots: { default: 'Submit' },
    })
    expect(wrapper.attributes('type')).toBe('submit')
  })
})
