/**
 * Tests for the PgBadge primitive -- variant resolution + slot rendering.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PgBadge from '../components/ui/PgBadge.vue'

describe('PgBadge', () => {
  it('renders the slot content', () => {
    const wrapper = mount(PgBadge, { slots: { default: 'completed' } })
    expect(wrapper.text()).toBe('completed')
  })

  it('uses the explicit variant prop when provided', () => {
    const wrapper = mount(PgBadge, {
      props: { variant: 'success' },
      slots: { default: 'ok' },
    })
    expect(wrapper.classes()).toContain('pg-badge-success')
    expect(wrapper.attributes('data-variant')).toBe('success')
  })

  it('derives the variant from the status prop', () => {
    const wrapper = mount(PgBadge, {
      props: { status: 'failed' },
      slots: { default: 'failed' },
    })
    expect(wrapper.classes()).toContain('pg-badge-danger')
    expect(wrapper.attributes('data-variant')).toBe('danger')
  })

  it('derives the variant from the capability prop', () => {
    const wrapper = mount(PgBadge, {
      props: { capability: 'degraded' },
      slots: { default: 'degraded' },
    })
    expect(wrapper.classes()).toContain('pg-badge-warning')
  })

  it('derives the variant from the category prop', () => {
    const wrapper = mount(PgBadge, {
      props: { category: 'memory' },
      slots: { default: 'memory' },
    })
    expect(wrapper.classes()).toContain('pg-badge-violet')
  })

  it('defaults to the muted variant when nothing matches', () => {
    const wrapper = mount(PgBadge, { slots: { default: 'na' } })
    expect(wrapper.classes()).toContain('pg-badge-muted')
  })

  it('applies the small size class when size="sm"', () => {
    const wrapper = mount(PgBadge, {
      props: { size: 'sm' },
      slots: { default: 'tag' },
    })
    expect(wrapper.classes().some(c => c.startsWith('text-['))).toBe(true)
  })

  it('explicit variant wins over status/capability/category', () => {
    const wrapper = mount(PgBadge, {
      props: { variant: 'accent', status: 'failed' },
      slots: { default: 'x' },
    })
    expect(wrapper.classes()).toContain('pg-badge-accent')
    expect(wrapper.classes()).not.toContain('pg-badge-danger')
  })
})
