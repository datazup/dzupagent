/**
 * Tests for the AgentCard component (marketplace).
 *
 * Covers rendering of agent information, install/uninstall actions,
 * download counts, ratings, verified badge, and tag truncation.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentCard from '../components/marketplace/AgentCard.vue'
import type { MarketplaceAgent } from '../types.js'

function makeAgent(overrides: Partial<MarketplaceAgent> = {}): MarketplaceAgent {
  return {
    id: 'plugin-test',
    name: '@forge/test-plugin',
    description: 'A test plugin for unit testing',
    version: '1.0.0',
    author: 'TestAuthor',
    category: 'codegen',
    tags: ['typescript', 'testing'],
    installed: false,
    verified: true,
    downloadCount: 5000,
    rating: 4.2,
    ...overrides,
  }
}

describe('AgentCard', () => {
  // -- Rendering --

  it('renders agent name', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ name: '@forge/code-analyzer' }) },
    })
    expect(wrapper.text()).toContain('@forge/code-analyzer')
  })

  it('renders agent description', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ description: 'Analyzes TypeScript code quality' }) },
    })
    expect(wrapper.text()).toContain('Analyzes TypeScript code quality')
  })

  it('renders version badge', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ version: '2.5.1' }) },
    })
    expect(wrapper.text()).toContain('v2.5.1')
  })

  it('renders author name', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ author: 'ForgeTeam' }) },
    })
    expect(wrapper.text()).toContain('by ForgeTeam')
  })

  it('renders category badge', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ category: 'memory' }) },
    })
    expect(wrapper.text()).toContain('memory')
  })

  it('renders tags', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ tags: ['redis', 'cache', 'store'] }) },
    })
    expect(wrapper.text()).toContain('redis')
    expect(wrapper.text()).toContain('cache')
    expect(wrapper.text()).toContain('store')
  })

  it('truncates tags after 3 and shows "+N" indicator', () => {
    const wrapper = mount(AgentCard, {
      props: {
        agent: makeAgent({
          tags: ['a', 'b', 'c', 'd', 'e'],
        }),
      },
    })
    expect(wrapper.text()).toContain('+2')
  })

  it('does not show "+N" when tags are 3 or fewer', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ tags: ['a', 'b'] }) },
    })
    expect(wrapper.text()).not.toContain('+')
  })

  // -- Verified badge --

  it('shows verified indicator when verified is true', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ verified: true }) },
    })
    expect(wrapper.text()).toContain('[v]')
  })

  it('does not show verified indicator when verified is false', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ verified: false }) },
    })
    expect(wrapper.text()).not.toContain('[v]')
  })

  // -- Download count --

  it('formats download count as "Xk" for thousands', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ downloadCount: 12450 }) },
    })
    expect(wrapper.text()).toContain('12.4k downloads')
  })

  it('shows raw count for values under 1000', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ downloadCount: 500 }) },
    })
    expect(wrapper.text()).toContain('500 downloads')
  })

  it('does not show download count when undefined', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ downloadCount: undefined }) },
    })
    expect(wrapper.text()).not.toContain('downloads')
  })

  // -- Rating --

  it('shows rating when present', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ rating: 4.5 }) },
    })
    expect(wrapper.text()).toContain('4.5/5')
  })

  it('does not show rating when undefined', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ rating: undefined }) },
    })
    expect(wrapper.text()).not.toContain('/5')
  })

  // -- Install/Uninstall --

  it('shows "Install" button when not installed', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ installed: false }) },
    })
    const btn = wrapper.find('button')
    expect(btn.text()).toBe('Install')
  })

  it('shows "Uninstall" button when installed', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ installed: true }) },
    })
    const btn = wrapper.find('button')
    expect(btn.text()).toBe('Uninstall')
  })

  it('emits install event when Install button is clicked', async () => {
    const agent = makeAgent({ id: 'plugin-abc', installed: false })
    const wrapper = mount(AgentCard, { props: { agent } })

    await wrapper.find('button').trigger('click')

    expect(wrapper.emitted('install')).toHaveLength(1)
    expect(wrapper.emitted('install')![0]).toEqual(['plugin-abc'])
  })

  it('emits uninstall event when Uninstall button is clicked', async () => {
    const agent = makeAgent({ id: 'plugin-xyz', installed: true })
    const wrapper = mount(AgentCard, { props: { agent } })

    await wrapper.find('button').trigger('click')

    expect(wrapper.emitted('uninstall')).toHaveLength(1)
    expect(wrapper.emitted('uninstall')![0]).toEqual(['plugin-xyz'])
  })

  it('shows "Working..." when actionLoading is true', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent(), actionLoading: true },
    })
    const btn = wrapper.find('button')
    expect(btn.text()).toBe('Working...')
  })

  it('disables button when actionLoading is true', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent(), actionLoading: true },
    })
    const btn = wrapper.find('button')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
  })

  // -- ARIA --

  it('has correct aria-label on install button', () => {
    const agent = makeAgent({ name: '@forge/my-plugin', installed: false })
    const wrapper = mount(AgentCard, { props: { agent } })
    const btn = wrapper.find('button')
    expect(btn.attributes('aria-label')).toBe('Install @forge/my-plugin')
  })

  it('has correct aria-label on uninstall button', () => {
    const agent = makeAgent({ name: '@forge/my-plugin', installed: true })
    const wrapper = mount(AgentCard, { props: { agent } })
    const btn = wrapper.find('button')
    expect(btn.attributes('aria-label')).toBe('Uninstall @forge/my-plugin')
  })

  // -- data-testid --

  it('has data-testid with agent id', () => {
    const wrapper = mount(AgentCard, {
      props: { agent: makeAgent({ id: 'plugin-otel' }) },
    })
    expect(wrapper.find('[data-testid="agent-card-plugin-otel"]').exists()).toBe(true)
  })
})
