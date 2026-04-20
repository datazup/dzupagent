import { describe, expect, it } from 'vitest'

import { buildWatcherRegistrations } from '../projectors/watchers.js'
import type { AdapterRule, CompileContext, WatcherRegistration } from '../types.js'

function rule(
  partial: Partial<AdapterRule> & { id: string; appliesToProviders: string[] },
): AdapterRule {
  return {
    name: partial.name ?? partial.id,
    scope: partial.scope ?? 'project',
    appliesToProviders: partial.appliesToProviders,
    match: partial.match,
    effects: partial.effects ?? [],
    ...partial,
  }
}

const claudeCtx: CompileContext = { providerId: 'claude' }

function findByPath(regs: WatcherRegistration[], path: string): WatcherRegistration | undefined {
  return regs.find((r) => r.path === path)
}

describe('buildWatcherRegistrations', () => {
  it('returns only the .dzupagent watcher when rules is empty', () => {
    const regs = buildWatcherRegistrations([], claudeCtx)
    expect(regs).toHaveLength(1)
    expect(regs[0]).toEqual({
      path: '.dzupagent/',
      provider: 'dzupagent',
      watchClass: 'dzupagent',
      description: 'DzupAgent workspace metadata (capabilities, memories, skills)',
    })
  })

  it('includes both .claude/ and ~/.claude/ paths for a claude-targeted rule', () => {
    const regs = buildWatcherRegistrations(
      [rule({ id: 'r1', appliesToProviders: ['claude'] })],
      claudeCtx,
    )
    expect(findByPath(regs, '.claude/')).toMatchObject({
      provider: 'claude',
      watchClass: 'project',
    })
    expect(findByPath(regs, '~/.claude/')).toMatchObject({
      provider: 'claude',
      watchClass: 'home',
    })
  })

  it('emits paths from all targeted providers and deduplicates repeated ones', () => {
    const regs = buildWatcherRegistrations(
      [
        rule({ id: 'r1', appliesToProviders: ['claude'] }),
        rule({ id: 'r2', appliesToProviders: ['codex'] }),
        // Duplicate claude rule — should not produce duplicate registrations.
        rule({ id: 'r3', appliesToProviders: ['claude'] }),
      ],
      claudeCtx,
    )

    const paths = regs.map((r) => r.path)
    expect(paths).toContain('.claude/')
    expect(paths).toContain('~/.claude/')
    expect(paths).toContain('.codex/')
    expect(paths).toContain('~/.codex/')

    // Deduplicated: each path appears exactly once.
    const unique = new Set(paths)
    expect(unique.size).toBe(paths.length)
  })

  it('includes all three goose paths for a goose-targeted rule', () => {
    const regs = buildWatcherRegistrations(
      [rule({ id: 'r1', appliesToProviders: ['goose'] })],
      { providerId: 'goose' },
    )

    expect(findByPath(regs, '.goosehints')).toMatchObject({
      provider: 'goose',
      watchClass: 'project',
    })
    expect(findByPath(regs, '~/.config/goose/')).toMatchObject({
      provider: 'goose',
      watchClass: 'home',
    })
    expect(findByPath(regs, '~/.local/share/goose/')).toMatchObject({
      provider: 'goose',
      watchClass: 'home',
    })
  })

  it('includes all three crush paths for a crush-targeted rule', () => {
    const regs = buildWatcherRegistrations(
      [rule({ id: 'r1', appliesToProviders: ['crush'] })],
      { providerId: 'crush' },
    )

    expect(findByPath(regs, '.crush/')).toMatchObject({
      provider: 'crush',
      watchClass: 'project',
    })
    expect(findByPath(regs, '~/.config/crush/')).toMatchObject({
      provider: 'crush',
      watchClass: 'home',
    })
    expect(findByPath(regs, '~/.local/share/crush/')).toMatchObject({
      provider: 'crush',
      watchClass: 'home',
    })
  })

  it('uses context.workspaceDir as base for relative project paths', () => {
    const regs = buildWatcherRegistrations(
      [rule({ id: 'r1', appliesToProviders: ['claude'] })],
      { providerId: 'claude', workspaceDir: '/home/alice/project' },
    )

    const claudeProject = regs.find((r) => r.provider === 'claude' && r.watchClass === 'project')
    expect(claudeProject?.path).toBe('/home/alice/project/.claude/')

    const dzupagent = regs.find((r) => r.watchClass === 'dzupagent')
    expect(dzupagent?.path).toBe('/home/alice/project/.dzupagent/')

    // Home paths are not rewritten — the runtime expands ~ itself.
    const claudeHome = regs.find((r) => r.provider === 'claude' && r.watchClass === 'home')
    expect(claudeHome?.path).toBe('~/.claude/')
  })

  it('handles workspaceDir already ending in a slash without double-slashing', () => {
    const regs = buildWatcherRegistrations(
      [rule({ id: 'r1', appliesToProviders: ['claude'] })],
      { providerId: 'claude', workspaceDir: '/home/alice/project/' },
    )
    const claudeProject = regs.find((r) => r.provider === 'claude' && r.watchClass === 'project')
    expect(claudeProject?.path).toBe('/home/alice/project/.claude/')
  })

  it('ignores unknown providers without throwing', () => {
    const regs = buildWatcherRegistrations(
      [rule({ id: 'r1', appliesToProviders: ['unknown-provider'] })],
      claudeCtx,
    )
    // Only the always-on .dzupagent/ watcher remains.
    expect(regs).toHaveLength(1)
    expect(regs[0]?.watchClass).toBe('dzupagent')
  })

  it('emits paths for multiple providers declared on a single rule', () => {
    const regs = buildWatcherRegistrations(
      [rule({ id: 'r1', appliesToProviders: ['gemini', 'qwen'] })],
      { providerId: 'gemini' },
    )
    const paths = regs.map((r) => r.path)
    expect(paths).toContain('.gemini/')
    expect(paths).toContain('~/.gemini/')
    expect(paths).toContain('.qwen/')
    expect(paths).toContain('~/.qwen/')
  })
})
