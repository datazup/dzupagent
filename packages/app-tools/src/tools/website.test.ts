import { describe, expect, it } from 'vitest'
import { websiteTools, websiteToolBundle } from './website.js'

/**
 * Contract tests for the `website.*` namespace scaffold.
 *
 * Implementations live elsewhere (apps/website-app); these tests guard the
 * metadata contract so downstream callers can rely on stable shapes.
 */

describe('website.* — namespace contract', () => {
  it('every tool name starts with the website. prefix', () => {
    for (const tool of websiteTools) {
      expect(tool.name.startsWith('website.')).toBe(true)
      expect(tool.namespace).toBe('website')
    }
  })

  it('every tool has a non-empty description', () => {
    for (const tool of websiteTools) {
      expect(typeof tool.description).toBe('string')
      expect(tool.description.trim().length).toBeGreaterThan(0)
    }
  })

  it('publish_site is a write-tier tool requiring approval', () => {
    const publish = websiteTools.find((t) => t.name === 'website.publish_site')
    expect(publish).toBeDefined()
    expect(publish?.permissionLevel).toBe('write')
    expect(publish?.requiresApproval).toBe(true)
  })

  it('get_site_info is a read-tier tool with no side effects', () => {
    const info = websiteTools.find((t) => t.name === 'website.get_site_info')
    expect(info).toBeDefined()
    expect(info?.permissionLevel).toBe('read')
    expect(info?.sideEffects).toEqual([])
  })

  it('exposes at least 20 tool definitions', () => {
    expect(websiteTools.length).toBeGreaterThanOrEqual(20)
  })

  it('tool names are unique within the namespace', () => {
    const names = websiteTools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('websiteToolBundle.registry resolves every definition by name', () => {
    for (const tool of websiteTools) {
      expect(websiteToolBundle.registry.get(tool.name)).toEqual(tool)
    }
    expect(websiteToolBundle.registry.list().length).toBe(websiteTools.length)
  })
})
