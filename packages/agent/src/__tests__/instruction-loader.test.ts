import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadAgentsFiles } from '../instructions/instruction-loader.js'

describe('loadAgentsFiles', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agents-loader-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty array when no AGENTS.md files exist', async () => {
    const result = await loadAgentsFiles(tempDir)
    expect(result).toEqual([])
  })

  it('loads a single AGENTS.md at the root', async () => {
    await writeFile(join(tempDir, 'AGENTS.md'), `# TestAgent\nInstructions: Do things.`)

    const result = await loadAgentsFiles(tempDir)

    expect(result).toHaveLength(1)
    expect(result[0]!.path).toBe(join(tempDir, 'AGENTS.md'))
    expect(result[0]!.sections).toHaveLength(1)
    expect(result[0]!.sections[0]!.agentId).toBe('test-agent')
  })

  it('loads AGENTS.md from nested directories', async () => {
    await mkdir(join(tempDir, 'sub'), { recursive: true })
    await writeFile(join(tempDir, 'AGENTS.md'), `# Root\nInstructions: Root agent.`)
    await writeFile(join(tempDir, 'sub', 'AGENTS.md'), `# Sub\nInstructions: Sub agent.`)

    const result = await loadAgentsFiles(tempDir)

    expect(result).toHaveLength(2)
    // Root should come first (shallowest)
    expect(result[0]!.sections[0]!.agentId).toBe('root')
    expect(result[1]!.sections[0]!.agentId).toBe('sub')
  })

  it('skips node_modules directories', async () => {
    await mkdir(join(tempDir, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(
      join(tempDir, 'node_modules', 'pkg', 'AGENTS.md'),
      `# Pkg\nInstructions: Should not be found.`,
    )

    const result = await loadAgentsFiles(tempDir)
    expect(result).toEqual([])
  })

  it('skips .git directories', async () => {
    await mkdir(join(tempDir, '.git'), { recursive: true })
    await writeFile(join(tempDir, '.git', 'AGENTS.md'), `# Git\nInstructions: Nope.`)

    const result = await loadAgentsFiles(tempDir)
    expect(result).toEqual([])
  })

  it('respects maxDepth option', async () => {
    await mkdir(join(tempDir, 'a', 'b', 'c'), { recursive: true })
    await writeFile(join(tempDir, 'a', 'AGENTS.md'), `# Shallow\nInstructions: Found.`)
    await writeFile(join(tempDir, 'a', 'b', 'c', 'AGENTS.md'), `# Deep\nInstructions: Too deep.`)

    const result = await loadAgentsFiles(tempDir, { maxDepth: 2 })

    // Depth 0 = tempDir, depth 1 = a/, depth 2 = a/b/, depth 3 = a/b/c/ (too deep)
    expect(result).toHaveLength(1)
    expect(result[0]!.sections[0]!.agentId).toBe('shallow')
  })

  it('supports custom file names', async () => {
    await writeFile(join(tempDir, 'TEAM.md'), `# TeamAgent\nInstructions: Team file.`)
    await writeFile(join(tempDir, 'AGENTS.md'), `# Default\nInstructions: Default file.`)

    const result = await loadAgentsFiles(tempDir, { fileNames: ['TEAM.md'] })

    // Should only find the TEAM.md file, not AGENTS.md
    expect(result).toHaveLength(1)
    expect(result[0]!.sections[0]!.agentId).toBe('team-agent')
  })

  it('skips AGENTS.md files with no valid sections', async () => {
    await writeFile(join(tempDir, 'AGENTS.md'), 'Just some text without headings.')

    const result = await loadAgentsFiles(tempDir)
    expect(result).toEqual([])
  })

  it('respects simple .gitignore patterns', async () => {
    await writeFile(join(tempDir, '.gitignore'), 'build\ntmp\n')
    await mkdir(join(tempDir, 'build'), { recursive: true })
    await mkdir(join(tempDir, 'src'), { recursive: true })
    await writeFile(join(tempDir, 'build', 'AGENTS.md'), `# Build\nInstructions: Ignored.`)
    await writeFile(join(tempDir, 'src', 'AGENTS.md'), `# Src\nInstructions: Found.`)

    const result = await loadAgentsFiles(tempDir)

    expect(result).toHaveLength(1)
    expect(result[0]!.sections[0]!.agentId).toBe('src')
  })
})
