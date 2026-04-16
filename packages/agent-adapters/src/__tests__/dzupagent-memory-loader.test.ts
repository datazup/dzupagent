import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { DzupAgentMemoryLoader } from '../dzupagent/memory-loader.js'
import type { DzupAgentMemoryLoaderOptions, MemoryEntry } from '../dzupagent/memory-loader.js'
import type { DzupAgentPaths } from '../types.js'
import type { AgentMemoryRecalledEvent } from '../types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePaths(base: string): DzupAgentPaths {
  return {
    globalDir: join(base, 'global', '.dzupagent'),
    workspaceDir: undefined,
    projectDir: join(base, 'project', '.dzupagent'),
    stateFile: join(base, 'project', '.dzupagent', 'state.json'),
    projectConfig: join(base, 'project', '.dzupagent', 'config.json'),
  }
}

async function makeTestDir(): Promise<string> {
  const dir = join(tmpdir(), `dzup-mem-test-${randomBytes(6).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  return dir
}

function makeLoader(
  paths: DzupAgentPaths,
  overrides?: Partial<DzupAgentMemoryLoaderOptions>,
): DzupAgentMemoryLoader {
  return new DzupAgentMemoryLoader({
    paths,
    providerId: 'claude',
    ...overrides,
  })
}

const MEMORY_GLOBAL = `---
name: coding-standards
description: Global coding standards
tags: [style, lint]
---

Always use strict TypeScript. No any types.
`

const MEMORY_PROJECT = `---
name: project-context
description: Project-specific context
tags: [project]
---

This project uses Vitest for testing and tsup for building.
`

const MEMORY_WORKSPACE = `---
name: workspace-conventions
description: Workspace-level conventions
tags: [workspace]
---

All packages use ESM. Node 20+.
`

const MEMORY_AGENT = `---
name: claude-preferences
description: Claude-specific preferences
tags: [agent, claude]
---

Prefer concise responses. Use bullet points.
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DzupAgentMemoryLoader', () => {
  let testDir: string
  let paths: DzupAgentPaths

  beforeEach(async () => {
    testDir = await makeTestDir()
    paths = makePaths(testDir)
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // 1. Load entries from global + project directories
  // -------------------------------------------------------------------------

  it('loads entries from global and project directories', async () => {
    const globalMemDir = join(paths.globalDir, 'memory')
    const projectMemDir = join(paths.projectDir, 'memory')
    await mkdir(globalMemDir, { recursive: true })
    await mkdir(projectMemDir, { recursive: true })

    await writeFile(join(globalMemDir, 'coding-standards.md'), MEMORY_GLOBAL)
    await writeFile(join(projectMemDir, 'project-context.md'), MEMORY_PROJECT)

    const loader = makeLoader(paths)
    const entries = await loader.loadEntries()

    expect(entries).toHaveLength(2)
    const names = entries.map((e) => e.name)
    expect(names).toContain('coding-standards')
    expect(names).toContain('project-context')
  })

  // -------------------------------------------------------------------------
  // 2. Entries sorted correctly (global before project)
  // -------------------------------------------------------------------------

  it('sorts entries: global before project', async () => {
    const globalMemDir = join(paths.globalDir, 'memory')
    const projectMemDir = join(paths.projectDir, 'memory')
    await mkdir(globalMemDir, { recursive: true })
    await mkdir(projectMemDir, { recursive: true })

    await writeFile(join(globalMemDir, 'coding-standards.md'), MEMORY_GLOBAL)
    await writeFile(join(projectMemDir, 'project-context.md'), MEMORY_PROJECT)

    const loader = makeLoader(paths)
    const entries = await loader.loadEntries()

    expect(entries[0]!.name).toBe('coding-standards')
    expect(entries[0]!.type).toBe('global')
    expect(entries[1]!.name).toBe('project-context')
    expect(entries[1]!.type).toBe('project')
  })

  // -------------------------------------------------------------------------
  // 3. Token budget truncation: drops last entry when budget exceeded
  // -------------------------------------------------------------------------

  it('drops entries from end when token budget is exceeded', async () => {
    const projectMemDir = join(paths.projectDir, 'memory')
    await mkdir(projectMemDir, { recursive: true })

    // Create 3 entries each ~1000 tokens (4000 chars each)
    const bigContent = (name: string, body: string): string =>
      `---\nname: ${name}\n---\n\n${body}\n`

    await writeFile(
      join(projectMemDir, 'a-first.md'),
      bigContent('first', 'x'.repeat(4000)),
    )
    await writeFile(
      join(projectMemDir, 'b-second.md'),
      bigContent('second', 'y'.repeat(4000)),
    )
    await writeFile(
      join(projectMemDir, 'c-third.md'),
      bigContent('third', 'z'.repeat(4000)),
    )

    const loader = makeLoader(paths, { maxTotalTokens: 2000 })
    const entries = await loader.loadEntries()

    // Should fit first two (~1000 each) but not the third
    expect(entries).toHaveLength(2)
    expect(entries[0]!.name).toBe('first')
    expect(entries[1]!.name).toBe('second')
  })

  // -------------------------------------------------------------------------
  // 4. shouldInject: codex + trust-thread-history + isResume=false -> false
  // -------------------------------------------------------------------------

  it('shouldInject returns false for codex with trust-thread-history (even when not resume)', () => {
    const loader = makeLoader(paths, {
      providerId: 'codex',
      codexMemoryStrategy: 'trust-thread-history',
    })
    expect(loader.shouldInject(false)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 5. shouldInject: codex + inject-on-new-thread + isResume=true -> false
  // -------------------------------------------------------------------------

  it('shouldInject returns false for codex with inject-on-new-thread when resuming', () => {
    const loader = makeLoader(paths, {
      providerId: 'codex',
      codexMemoryStrategy: 'inject-on-new-thread',
    })
    expect(loader.shouldInject(true)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 6. shouldInject: codex + inject-always + isResume=true -> true
  // -------------------------------------------------------------------------

  it('shouldInject returns true for codex with inject-always even when resuming', () => {
    const loader = makeLoader(paths, {
      providerId: 'codex',
      codexMemoryStrategy: 'inject-always',
    })
    expect(loader.shouldInject(true)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 7. shouldInject: claude + any strategy -> true
  // -------------------------------------------------------------------------

  it('shouldInject always returns true for non-codex providers', () => {
    const loader = makeLoader(paths, {
      providerId: 'claude',
      codexMemoryStrategy: 'trust-thread-history',
    })
    expect(loader.shouldInject(false)).toBe(true)
    expect(loader.shouldInject(true)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 8. search() returns Record<string, unknown>[] with expected keys
  // -------------------------------------------------------------------------

  it('search() returns records with content key', async () => {
    const projectMemDir = join(paths.projectDir, 'memory')
    await mkdir(projectMemDir, { recursive: true })
    await writeFile(join(projectMemDir, 'project-context.md'), MEMORY_PROJECT)

    const loader = makeLoader(paths)
    const results = await loader.search('memory', {}, 'test')

    expect(results).toHaveLength(1)
    expect(results[0]!['content']).toBeDefined()
    expect(typeof results[0]!['content']).toBe('string')
    expect(results[0]!['name']).toBe('project-context')
    expect(results[0]!['tokenEstimate']).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // 9. Missing directories handled gracefully
  // -------------------------------------------------------------------------

  it('handles missing directories gracefully without throwing', async () => {
    const loader = makeLoader(paths)
    const entries = await loader.loadEntries()
    expect(entries).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // 10. onRecalled callback invoked with correct metadata
  // -------------------------------------------------------------------------

  it('invokes onRecalled callback with correct metadata', async () => {
    const projectMemDir = join(paths.projectDir, 'memory')
    await mkdir(projectMemDir, { recursive: true })
    await writeFile(join(projectMemDir, 'project-context.md'), MEMORY_PROJECT)

    let capturedEntries: AgentMemoryRecalledEvent['entries'] = []
    let capturedTotal = 0

    const loader = makeLoader(paths, {
      onRecalled: (entries, totalTokens) => {
        capturedEntries = entries
        capturedTotal = totalTokens
      },
    })

    await loader.loadEntries()

    expect(capturedEntries).toHaveLength(1)
    expect(capturedEntries[0]!.level).toBe('project')
    expect(capturedEntries[0]!.name).toBe('project-context')
    expect(capturedEntries[0]!.tokenEstimate).toBeGreaterThan(0)
    expect(capturedTotal).toBe(capturedEntries[0]!.tokenEstimate)
  })

  // -------------------------------------------------------------------------
  // 11. Workspace-level entries loaded when workspaceDir is defined
  // -------------------------------------------------------------------------

  it('loads workspace-level entries when workspaceDir is defined', async () => {
    const workspaceDir = join(testDir, 'workspace', '.dzupagent')
    const pathsWithWs = { ...paths, workspaceDir }

    const wsMemDir = join(workspaceDir, 'memory')
    const globalMemDir = join(paths.globalDir, 'memory')
    await mkdir(wsMemDir, { recursive: true })
    await mkdir(globalMemDir, { recursive: true })

    await writeFile(join(globalMemDir, 'coding-standards.md'), MEMORY_GLOBAL)
    await writeFile(join(wsMemDir, 'workspace-conventions.md'), MEMORY_WORKSPACE)

    const loader = makeLoader(pathsWithWs)
    const entries = await loader.loadEntries()

    expect(entries).toHaveLength(2)
    // Global before workspace
    expect(entries[0]!.type).toBe('global')
    expect(entries[1]!.type).toBe('workspace')
    expect(entries[1]!.name).toBe('workspace-conventions')
  })

  // -------------------------------------------------------------------------
  // 12. Single entry exceeding budget: included with content truncated
  // -------------------------------------------------------------------------

  it('truncates a single entry that exceeds the entire budget', async () => {
    const projectMemDir = join(paths.projectDir, 'memory')
    await mkdir(projectMemDir, { recursive: true })

    const hugeBody = 'A'.repeat(10000) // ~2500 tokens
    const content = `---\nname: huge-entry\n---\n\n${hugeBody}\n`
    await writeFile(join(projectMemDir, 'huge-entry.md'), content)

    const loader = makeLoader(paths, { maxTotalTokens: 500 })
    const entries = await loader.loadEntries()

    expect(entries).toHaveLength(1)
    expect(entries[0]!.name).toBe('huge-entry')
    expect(entries[0]!.tokenEstimate).toBe(500)
    // Content should be truncated to 500 * 4 = 2000 chars
    expect(entries[0]!.content.length).toBeLessThanOrEqual(2000)
  })

  // -------------------------------------------------------------------------
  // P3-FIX-1: Skip entries with empty content
  // -------------------------------------------------------------------------

  it('skips .md files with only frontmatter and no body', async () => {
    const projectMemDir = join(paths.projectDir, 'memory')
    await mkdir(projectMemDir, { recursive: true })

    const emptyBody = `---\nname: empty-entry\ndescription: Has no body\ntags: [test]\n---\n`
    await writeFile(join(projectMemDir, 'empty-entry.md'), emptyBody)
    await writeFile(join(projectMemDir, 'real-entry.md'), MEMORY_PROJECT)

    const loader = makeLoader(paths)
    const entries = await loader.loadEntries()

    expect(entries).toHaveLength(1)
    expect(entries[0]!.name).toBe('project-context')
  })

  // -------------------------------------------------------------------------
  // Additional: search() respects limit parameter
  // -------------------------------------------------------------------------

  it('search() respects limit parameter', async () => {
    const projectMemDir = join(paths.projectDir, 'memory')
    await mkdir(projectMemDir, { recursive: true })

    await writeFile(join(projectMemDir, 'a-first.md'), `---\nname: first\n---\n\nFirst entry.\n`)
    await writeFile(join(projectMemDir, 'b-second.md'), `---\nname: second\n---\n\nSecond entry.\n`)

    const loader = makeLoader(paths)
    const results = await loader.search('memory', {}, 'test', 1)
    expect(results).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Additional: type inferred from directory when not in frontmatter
  // -------------------------------------------------------------------------

  it('infers type from directory when frontmatter type is missing', async () => {
    const globalMemDir = join(paths.globalDir, 'memory')
    await mkdir(globalMemDir, { recursive: true })

    const noTypeContent = `---\nname: no-type\n---\n\nSome content.\n`
    await writeFile(join(globalMemDir, 'no-type.md'), noTypeContent)

    const loader = makeLoader(paths)
    const entries = await loader.loadEntries()

    expect(entries).toHaveLength(1)
    expect(entries[0]!.type).toBe('global')
  })

  // -------------------------------------------------------------------------
  // Additional: mtime cache works (second call returns cached entries)
  // -------------------------------------------------------------------------

  it('returns cached entries on second call without file changes', async () => {
    const projectMemDir = join(paths.projectDir, 'memory')
    await mkdir(projectMemDir, { recursive: true })
    await writeFile(join(projectMemDir, 'project-context.md'), MEMORY_PROJECT)

    const loader = makeLoader(paths)
    const first = await loader.loadEntries()
    const second = await loader.loadEntries()

    // Same object identity proves cache hit
    expect(first[0]).toBe(second[0])
  })
})
