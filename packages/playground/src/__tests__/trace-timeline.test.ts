/**
 * Tests for TraceTimeline and TraceTimelineCard components.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import TraceTimeline from '../components/TraceTimeline.vue'
import TraceTimelineCard from '../components/TraceTimelineCard.vue'
import { useTraceStore } from '../stores/trace-store.js'
import type { TraceEvent } from '../types.js'

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: 'llm',
    name: 'test-event',
    startedAt: new Date().toISOString(),
    durationMs: 150,
    ...overrides,
  }
}

describe('TraceTimelineCard', () => {
  it('renders event name and duration', () => {
    setActivePinia(createPinia())
    const event = makeEvent({ name: 'generateResponse', durationMs: 1200 })

    const wrapper = mount(TraceTimelineCard, {
      props: { event, expanded: false },
    })

    expect(wrapper.text()).toContain('generateResponse')
    expect(wrapper.text()).toContain('1.2s')
  })

  it('renders type badge label', () => {
    setActivePinia(createPinia())
    const event = makeEvent({ type: 'tool', name: 'searchDocs' })

    const wrapper = mount(TraceTimelineCard, {
      props: { event, expanded: false },
    })

    expect(wrapper.text()).toContain('TOOL')
  })

  it('shows metadata when expanded and metadata exists', () => {
    setActivePinia(createPinia())
    const event = makeEvent({
      metadata: { model: 'claude-3', tokens: 500 },
    })

    const wrapper = mount(TraceTimelineCard, {
      props: { event, expanded: true },
    })

    expect(wrapper.text()).toContain('Metadata')
    expect(wrapper.text()).toContain('claude-3')
    expect(wrapper.text()).toContain('500')
  })

  it('shows "No metadata available" when expanded without metadata', () => {
    setActivePinia(createPinia())
    const event = makeEvent({ metadata: undefined })

    const wrapper = mount(TraceTimelineCard, {
      props: { event, expanded: true },
    })

    expect(wrapper.text()).toContain('No metadata available')
  })

  it('does not show metadata section when collapsed', () => {
    setActivePinia(createPinia())
    const event = makeEvent({
      metadata: { model: 'claude-3' },
    })

    const wrapper = mount(TraceTimelineCard, {
      props: { event, expanded: false },
    })

    expect(wrapper.text()).not.toContain('Metadata')
    expect(wrapper.text()).not.toContain('claude-3')
  })

  it('emits toggle event on click', async () => {
    setActivePinia(createPinia())
    const event = makeEvent()

    const wrapper = mount(TraceTimelineCard, {
      props: { event, expanded: false },
    })

    await wrapper.find('[role="button"]').trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)
  })

  it('emits toggle on Enter keydown', async () => {
    setActivePinia(createPinia())
    const event = makeEvent()

    const wrapper = mount(TraceTimelineCard, {
      props: { event, expanded: false },
    })

    await wrapper.find('[role="button"]').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('toggle')).toHaveLength(1)
  })

  it('emits toggle on Space keydown', async () => {
    setActivePinia(createPinia())
    const event = makeEvent()

    const wrapper = mount(TraceTimelineCard, {
      props: { event, expanded: false },
    })

    await wrapper.find('[role="button"]').trigger('keydown', { key: ' ' })
    expect(wrapper.emitted('toggle')).toHaveLength(1)
  })

  it('sets aria-expanded attribute correctly', () => {
    setActivePinia(createPinia())
    const event = makeEvent()

    const collapsed = mount(TraceTimelineCard, {
      props: { event, expanded: false },
    })
    expect(collapsed.find('[role="button"]').attributes('aria-expanded')).toBe('false')

    const expanded = mount(TraceTimelineCard, {
      props: { event, expanded: true },
    })
    expect(expanded.find('[role="button"]').attributes('aria-expanded')).toBe('true')
  })

  it('has left border accent color from event type', () => {
    setActivePinia(createPinia())
    const event = makeEvent({ type: 'tool' })

    const wrapper = mount(TraceTimelineCard, {
      props: { event, expanded: false },
    })

    const style = wrapper.find('.group').attributes('style')
    expect(style).toContain('border-left-color: var(--color-pg-success)')
  })

  it('renders different badge classes for each event type', () => {
    setActivePinia(createPinia())

    const types: TraceEvent['type'][] = ['llm', 'tool', 'memory', 'guardrail', 'system']
    const labels = ['LLM', 'TOOL', 'MEM', 'GUARD', 'SYS']

    types.forEach((type, i) => {
      const event = makeEvent({ type })
      const wrapper = mount(TraceTimelineCard, {
        props: { event, expanded: false },
      })
      expect(wrapper.text()).toContain(labels[i])
    })
  })
})

describe('TraceTimeline', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows empty state when no events', () => {
    const wrapper = mount(TraceTimeline)
    expect(wrapper.text()).toContain('No trace events yet.')
  })

  it('does not show summary header when no events', () => {
    const wrapper = mount(TraceTimeline)
    expect(wrapper.text()).not.toContain('total')
    expect(wrapper.text()).not.toContain('Clear')
  })

  it('renders events from the trace store', () => {
    const store = useTraceStore()
    store.addEvent(makeEvent({ name: 'first-event' }))
    store.addEvent(makeEvent({ name: 'second-event' }))

    const wrapper = mount(TraceTimeline)

    expect(wrapper.text()).toContain('first-event')
    expect(wrapper.text()).toContain('second-event')
  })

  it('shows event count and total duration in summary', () => {
    const store = useTraceStore()
    store.addEvent(makeEvent({ durationMs: 100 }))
    store.addEvent(makeEvent({ durationMs: 200 }))

    const wrapper = mount(TraceTimeline)

    expect(wrapper.text()).toContain('2 events')
    expect(wrapper.text()).toContain('300ms total')
  })

  it('shows singular "event" for single event', () => {
    const store = useTraceStore()
    store.addEvent(makeEvent({ durationMs: 500 }))

    const wrapper = mount(TraceTimeline)

    expect(wrapper.text()).toContain('1 event')
    expect(wrapper.text()).not.toContain('1 events')
  })

  it('sorts events by startedAt ascending', () => {
    const store = useTraceStore()
    store.addEvent(makeEvent({
      id: 'late',
      name: 'late-event',
      startedAt: '2026-03-26T12:00:10Z',
    }))
    store.addEvent(makeEvent({
      id: 'early',
      name: 'early-event',
      startedAt: '2026-03-26T12:00:01Z',
    }))

    const wrapper = mount(TraceTimeline)
    const cards = wrapper.findAllComponents(TraceTimelineCard)

    expect((cards[0]?.props('event') as { name: string })?.name).toBe('early-event')
    expect((cards[1]?.props('event') as { name: string })?.name).toBe('late-event')
  })

  it('toggles card expansion on click', async () => {
    const store = useTraceStore()
    const event = makeEvent({ metadata: { key: 'value' } })
    store.addEvent(event)

    const wrapper = mount(TraceTimeline)

    // Initially collapsed
    expect(wrapper.text()).not.toContain('Metadata')

    // Click to expand
    await wrapper.find('[role="button"]').trigger('click')
    expect(wrapper.text()).toContain('Metadata')

    // Click again to collapse
    await wrapper.find('[role="button"]').trigger('click')
    expect(wrapper.text()).not.toContain('Metadata')
  })

  it('clears events when Clear button is clicked', async () => {
    const store = useTraceStore()
    store.addEvent(makeEvent({ name: 'to-be-cleared' }))

    const wrapper = mount(TraceTimeline)
    expect(wrapper.text()).toContain('to-be-cleared')

    await wrapper.find('button[aria-label="Clear all trace events"]').trigger('click')
    expect(store.events.length).toBe(0)
  })

  it('renders the vertical timeline line when events exist', () => {
    const store = useTraceStore()
    store.addEvent(makeEvent())

    const wrapper = mount(TraceTimeline)
    // The timeline line div
    const line = wrapper.find('.w-px.bg-pg-border')
    expect(line.exists()).toBe(true)
  })

  it('renders timeline dots for each event', () => {
    const store = useTraceStore()
    store.addEvent(makeEvent({ id: 'a' }))
    store.addEvent(makeEvent({ id: 'b' }))
    store.addEvent(makeEvent({ id: 'c' }))

    const wrapper = mount(TraceTimeline)
    const dots = wrapper.findAll('.rounded-full.border-2')
    expect(dots.length).toBe(3)
  })
})
