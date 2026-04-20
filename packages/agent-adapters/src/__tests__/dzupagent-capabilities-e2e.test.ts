/**
 * E2E integration test: file parsing → capability matrix pipeline
 *
 * Uses a real .dzupagent/ directory fixture written to a temp directory
 * (no mocking of file I/O or internal parsing). Covers:
 *   1. DzupAgentFileLoader reading real .md files from disk
 *   2. SkillCapabilityMatrixBuilder evaluating the parsed bundles
 *   3. Matrix shape, column presence, and per-provider status correctness
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DzupAgentFileLoader } from '../dzupagent/file-loader.js'
import { createDefaultSkillRegistry } from '../skills/adapter-skill-registry.js'
import { SkillCapabilityMatrixBuilder } from '../skills/skill-capability-matrix.js'
import type { DzupAgentPaths } from '../types.js'
import type { ProviderCapabilityRow } from '../skills/skill-capability-matrix.js'

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

/**
 * Primary skill: uses adapters: [claude, codex] in frontmatter (informational
 * only — the file-loader does not map this to any bundle field). Includes
 * tool bindings, constraints, and all prompt section types so the matrix
 * builder has rich data to evaluate.
 */
const TEST_SKILL_CONTENT = `---
name: test-skill
description: A test skill for integration testing
adapters: [claude, codex]
version: 1
owner: e2e-test-team
constraints:
  maxBudgetUsd: 2.0
  approvalMode: conditional
  networkPolicy: restricted
  toolPolicy: balanced
tools:
  required: [read_file]
  blocked: [exec_command]
---

## Persona
You are a helpful integration-test assistant.

## Task
Do something useful for the integration test suite.
`

/**
 * Second skill: minimal — no tool bindings, no constraints.
 * Used to verify buildForAll() and that the matrix is still well-formed
 * when optional fields are absent.
 */
const MINIMAL_SKILL_CONTENT = `---
name: minimal-skill
description: A minimal skill with no tools or constraints
version: 1
---

## Task
Perform a minimal operation with no side effects.
`

/**
 * Third skill: intentionally uses every constraint and tool binding mode
 * so we can verify full provider-capability degradation warnings.
 */
const FULL_CONSTRAINT_SKILL_CONTENT = `---
name: full-constraint-skill
description: Skill with every constraint set
version: 2
owner: platform-team
constraints:
  maxBudgetUsd: 10.0
  approvalMode: required
  networkPolicy: on
  toolPolicy: strict
tools:
  required: [read_file, search_code]
  optional: [write_file]
  blocked: [exec_command, delete_file]
---

## Persona
I am a strictly constrained agent.

## Safety
Never modify production data.

## Task
Execute tasks within strict budget and approval constraints.

## Output
Return a JSON summary of actions taken.
`

// ---------------------------------------------------------------------------
// Helper: build DzupAgentPaths pointing into the temp directory
// ---------------------------------------------------------------------------

function makePaths(base: string): DzupAgentPaths {
  return {
    globalDir: join(base, 'global'),
    workspaceDir: undefined,
    projectDir: join(base, 'project'),
    stateFile: join(base, 'project', '.dzupagent', 'state.json'),
    projectConfig: join(base, 'project', '.dzupagent', 'config.json'),
  }
}

// ---------------------------------------------------------------------------
// Shared fixture state
// ---------------------------------------------------------------------------

let fixtureDir: string
let projectSkillsDir: string

beforeAll(async () => {
  // Create a unique temp directory for the whole suite
  fixtureDir = await mkdtemp(join(tmpdir(), 'dzup-e2e-capabilities-'))
  projectSkillsDir = join(fixtureDir, 'project', 'skills')
  await mkdir(projectSkillsDir, { recursive: true })

  // Write the three skill fixtures
  await writeFile(join(projectSkillsDir, 'test-skill.md'), TEST_SKILL_CONTENT)
  await writeFile(join(projectSkillsDir, 'minimal-skill.md'), MINIMAL_SKILL_CONTENT)
  await writeFile(join(projectSkillsDir, 'full-constraint-skill.md'), FULL_CONSTRAINT_SKILL_CONTENT)
})

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('dzupagent capabilities E2E', () => {

  // -------------------------------------------------------------------------
  // File loading
  // -------------------------------------------------------------------------

  describe('DzupAgentFileLoader — real disk I/O', () => {
    it('loads all three skill files from the project skills directory', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundles = await loader.loadSkills()

      expect(bundles).toHaveLength(3)
      const ids = bundles.map((b) => b.bundleId).sort()
      expect(ids).toEqual(['full-constraint-skill', 'minimal-skill', 'test-skill'])
    })

    it('parses test-skill frontmatter fields correctly', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('test-skill')

      expect(bundle).toBeDefined()
      expect(bundle!.bundleId).toBe('test-skill')
      expect(bundle!.skillSetId).toBe('test-skill')
      expect(bundle!.skillSetVersion).toBe('1')
      expect(bundle!.metadata.owner).toBe('e2e-test-team')
    })

    it('parses test-skill constraints from frontmatter', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('test-skill')

      expect(bundle!.constraints.maxBudgetUsd).toBe(2.0)
      expect(bundle!.constraints.approvalMode).toBe('conditional')
      expect(bundle!.constraints.networkPolicy).toBe('restricted')
      expect(bundle!.constraints.toolPolicy).toBe('balanced')
    })

    it('parses test-skill tool bindings from frontmatter', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('test-skill')

      expect(bundle!.toolBindings).toContainEqual({ toolName: 'read_file', mode: 'required' })
      expect(bundle!.toolBindings).toContainEqual({ toolName: 'exec_command', mode: 'blocked' })
    })

    it('parses test-skill prompt sections (persona + task)', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('test-skill')

      const purposes = bundle!.promptSections.map((s) => s.purpose)
      expect(purposes).toContain('persona')
      expect(purposes).toContain('task')
    })

    it('parses minimal-skill with empty constraints and no tool bindings', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('minimal-skill')

      expect(bundle).toBeDefined()
      expect(bundle!.constraints).toEqual({})
      expect(bundle!.toolBindings).toHaveLength(0)
    })

    it('parses full-constraint-skill with all tool binding modes', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('full-constraint-skill')

      expect(bundle).toBeDefined()
      expect(bundle!.toolBindings).toContainEqual({ toolName: 'read_file', mode: 'required' })
      expect(bundle!.toolBindings).toContainEqual({ toolName: 'search_code', mode: 'required' })
      expect(bundle!.toolBindings).toContainEqual({ toolName: 'write_file', mode: 'optional' })
      expect(bundle!.toolBindings).toContainEqual({ toolName: 'exec_command', mode: 'blocked' })
      expect(bundle!.toolBindings).toContainEqual({ toolName: 'delete_file', mode: 'blocked' })
    })

    it('parses full-constraint-skill prompt sections (persona, safety, task, output)', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('full-constraint-skill')

      const purposes = bundle!.promptSections.map((s) => s.purpose)
      expect(purposes).toContain('persona')
      expect(purposes).toContain('safety')
      expect(purposes).toContain('task')
      expect(purposes).toContain('output')
    })

    it('prompt sections are ordered by ascending priority', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      // full-constraint-skill has persona/safety/task/output — all have known priorities
      const bundle = await loader.loadSkill('full-constraint-skill')

      const priorities = bundle!.promptSections.map((s) => s.priority)
      expect(priorities).toEqual([...priorities].sort((a, b) => a - b))
    })

    it('returns undefined for a skill name that does not exist on disk', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const result = await loader.loadSkill('does-not-exist')
      expect(result).toBeUndefined()
    })

    it('second loadSkills() call returns cached objects (same identity)', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const first = await loader.loadSkills()
      const second = await loader.loadSkills()

      // Same bundle object reference proves the in-memory cache was hit
      for (const bundle of first) {
        const match = second.find((b) => b.bundleId === bundle.bundleId)
        expect(match).toBe(bundle)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Matrix shape — columns
  // -------------------------------------------------------------------------

  describe('SkillCapabilityMatrix — provider columns', () => {
    it('matrix contains a column for every provider registered by createDefaultSkillRegistry()', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('test-skill')

      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      const matrix = builder.buildForSkill(bundle!)

      // createDefaultSkillRegistry registers: claude, codex, gemini, qwen, crush, goose, openrouter
      const providerIds = Object.keys(matrix.providers)
      expect(providerIds).toContain('claude')
      expect(providerIds).toContain('codex')
      expect(providerIds).toContain('gemini')
      expect(providerIds).toContain('qwen')
      expect(providerIds).toContain('crush')
      expect(providerIds).toContain('goose')
      expect(providerIds).toContain('openrouter')
    })

    it('matrix has exactly 7 provider columns (no extra, no missing)', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('test-skill')

      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      const matrix = builder.buildForSkill(bundle!)

      expect(Object.keys(matrix.providers)).toHaveLength(7)
    })

    it('matrix skillId and skillName are derived from the parsed bundle', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('test-skill')

      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      const matrix = builder.buildForSkill(bundle!)

      expect(matrix.skillId).toBe('test-skill')
      expect(matrix.skillName).toBe('test-skill')
    })

    it('every provider row has a warnings array (even if empty)', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('test-skill')

      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      const matrix = builder.buildForSkill(bundle!)

      for (const row of Object.values(matrix.providers)) {
        expect(Array.isArray(row?.warnings)).toBe(true)
      }
    })

    it('systemPrompt is active for every provider', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('test-skill')

      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      const matrix = builder.buildForSkill(bundle!)

      for (const row of Object.values(matrix.providers)) {
        expect(row?.systemPrompt).toBe('active')
      }
    })
  })

  // -------------------------------------------------------------------------
  // Per-provider capability status (test-skill has all constraints + tools)
  // -------------------------------------------------------------------------

  describe('SkillCapabilityMatrix — per-provider status for test-skill', () => {
    async function buildTestSkillMatrix() {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('test-skill')
      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      return builder.buildForSkill(bundle!)
    }

    it('claude: all capabilities are active', async () => {
      const matrix = await buildTestSkillMatrix()
      const row = matrix.providers['claude'] as ProviderCapabilityRow

      expect(row.systemPrompt).toBe('active')
      expect(row.toolBindings).toBe('active')
      expect(row.approvalMode).toBe('active')
      expect(row.networkPolicy).toBe('active')
      expect(row.budgetLimit).toBe('active')
    })

    it('claude: no dropped-capability warnings', async () => {
      const matrix = await buildTestSkillMatrix()
      const row = matrix.providers['claude'] as ProviderCapabilityRow

      const dropped = row.warnings.filter((w) => w.includes('dropped'))
      expect(dropped).toHaveLength(0)
    })

    it('codex: budgetLimit is dropped, all other capabilities are active', async () => {
      const matrix = await buildTestSkillMatrix()
      const row = matrix.providers['codex'] as ProviderCapabilityRow

      expect(row.systemPrompt).toBe('active')
      expect(row.toolBindings).toBe('active')
      expect(row.approvalMode).toBe('active')
      expect(row.networkPolicy).toBe('active')
      expect(row.budgetLimit).toBe('dropped')
    })

    it('codex: warning mentions budgetLimit', async () => {
      const matrix = await buildTestSkillMatrix()
      const row = matrix.providers['codex'] as ProviderCapabilityRow

      expect(row.warnings.some((w) => w.includes('budgetLimit'))).toBe(true)
    })

    it('gemini CLI: toolBindings, approvalMode, networkPolicy, budgetLimit are all dropped', async () => {
      const matrix = await buildTestSkillMatrix()
      const row = matrix.providers['gemini'] as ProviderCapabilityRow

      expect(row.systemPrompt).toBe('active')
      expect(row.toolBindings).toBe('dropped')
      expect(row.approvalMode).toBe('dropped')
      expect(row.networkPolicy).toBe('dropped')
      expect(row.budgetLimit).toBe('dropped')
    })

    it('gemini CLI: has at least one dropped-capability warning', async () => {
      const matrix = await buildTestSkillMatrix()
      const row = matrix.providers['gemini'] as ProviderCapabilityRow

      expect(row.warnings.length).toBeGreaterThan(0)
      expect(row.warnings.some((w) => w.includes('does not support'))).toBe(true)
    })

    const cliOnlyProviders = ['qwen', 'crush', 'goose', 'openrouter'] as const

    for (const pid of cliOnlyProviders) {
      it(`${pid}: all non-systemPrompt capabilities are dropped`, async () => {
        const matrix = await buildTestSkillMatrix()
        const row = matrix.providers[pid] as ProviderCapabilityRow

        expect(row.systemPrompt).toBe('active')
        expect(row.toolBindings).toBe('dropped')
        expect(row.approvalMode).toBe('dropped')
        expect(row.networkPolicy).toBe('dropped')
        expect(row.budgetLimit).toBe('dropped')
      })
    }
  })

  // -------------------------------------------------------------------------
  // Minimal skill — no constraints, no tool bindings
  // -------------------------------------------------------------------------

  describe('SkillCapabilityMatrix — minimal-skill (no constraints, no tools)', () => {
    async function buildMinimalSkillMatrix() {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundle = await loader.loadSkill('minimal-skill')
      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      return builder.buildForSkill(bundle!)
    }

    it('matrix is well-formed even with an empty constraints object', async () => {
      const matrix = await buildMinimalSkillMatrix()

      expect(matrix.skillId).toBe('minimal-skill')
      expect(Object.keys(matrix.providers)).toHaveLength(7)
    })

    it('no provider emits a dropped-capability warning (bundle uses no capabilities)', async () => {
      const matrix = await buildMinimalSkillMatrix()

      // The bundle has no tool bindings and no constraints, so nothing can be "dropped"
      for (const row of Object.values(matrix.providers)) {
        const dropped = row!.warnings.filter((w) => w.includes('dropped'))
        expect(dropped).toHaveLength(0)
      }
    })

    it('claude row: systemPrompt active, capability statuses still reflect provider table', async () => {
      const matrix = await buildMinimalSkillMatrix()
      const row = matrix.providers['claude'] as ProviderCapabilityRow

      // Provider static capabilities are always surfaced regardless of bundle usage
      expect(row.systemPrompt).toBe('active')
      expect(row.toolBindings).toBe('active')
      expect(row.budgetLimit).toBe('active')
    })
  })

  // -------------------------------------------------------------------------
  // buildForAll — pipeline end-to-end with multiple bundles
  // -------------------------------------------------------------------------

  describe('buildForAll — batch matrix building from real fixture files', () => {
    it('returns one matrix per loaded bundle', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundles = await loader.loadSkills()

      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      const matrices = builder.buildForAll(bundles)

      expect(matrices).toHaveLength(3)
    })

    it('each matrix skillId matches a loaded bundle id', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundles = await loader.loadSkills()

      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      const matrices = builder.buildForAll(bundles)

      const matrixIds = matrices.map((m) => m.skillId).sort()
      const bundleIds = bundles.map((b) => b.bundleId).sort()
      expect(matrixIds).toEqual(bundleIds)
    })

    it('every matrix has 7 provider columns', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundles = await loader.loadSkills()

      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      const matrices = builder.buildForAll(bundles)

      for (const matrix of matrices) {
        expect(Object.keys(matrix.providers)).toHaveLength(7)
      }
    })

    it('returns empty array when no skills are present in the directory', async () => {
      // Point a fresh loader at a directory that has no skills written to it
      const emptyDir = await mkdtemp(join(tmpdir(), 'dzup-e2e-empty-'))
      try {
        const loader = new DzupAgentFileLoader({ paths: makePaths(emptyDir) })
        const bundles = await loader.loadSkills()

        const registry = createDefaultSkillRegistry()
        const builder = new SkillCapabilityMatrixBuilder(registry)
        const matrices = builder.buildForAll(bundles)

        expect(matrices).toHaveLength(0)
      } finally {
        await rm(emptyDir, { recursive: true, force: true })
      }
    })

    it('full-constraint-skill matrix: gemini drops all four capabilities with warnings', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundles = await loader.loadSkills()

      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      const matrices = builder.buildForAll(bundles)

      const fullMatrix = matrices.find((m) => m.skillId === 'full-constraint-skill')
      expect(fullMatrix).toBeDefined()

      const geminiRow = fullMatrix!.providers['gemini'] as ProviderCapabilityRow
      expect(geminiRow.toolBindings).toBe('dropped')
      expect(geminiRow.approvalMode).toBe('dropped')
      expect(geminiRow.networkPolicy).toBe('dropped')
      expect(geminiRow.budgetLimit).toBe('dropped')
      expect(geminiRow.warnings.length).toBeGreaterThan(0)
    })

    it('full-constraint-skill matrix: codex drops only budgetLimit', async () => {
      const loader = new DzupAgentFileLoader({ paths: makePaths(fixtureDir) })
      const bundles = await loader.loadSkills()

      const registry = createDefaultSkillRegistry()
      const builder = new SkillCapabilityMatrixBuilder(registry)
      const matrices = builder.buildForAll(bundles)

      const fullMatrix = matrices.find((m) => m.skillId === 'full-constraint-skill')
      const codexRow = fullMatrix!.providers['codex'] as ProviderCapabilityRow

      expect(codexRow.toolBindings).toBe('active')
      expect(codexRow.approvalMode).toBe('active')
      expect(codexRow.networkPolicy).toBe('active')
      expect(codexRow.budgetLimit).toBe('dropped')
    })
  })

  // -------------------------------------------------------------------------
  // Global + project tier merging (file-loader precedence)
  // -------------------------------------------------------------------------

  describe('tier precedence — project overrides global skill with same name', () => {
    it('project version of a skill takes precedence over the global version', async () => {
      // Create a second temp tree with global and project both having test-skill
      const tierDir = await mkdtemp(join(tmpdir(), 'dzup-e2e-tier-'))
      try {
        const globalSkillsDir = join(tierDir, 'global', 'skills')
        const projectSkillsDir = join(tierDir, 'project', 'skills')
        await mkdir(globalSkillsDir, { recursive: true })
        await mkdir(projectSkillsDir, { recursive: true })

        const globalVersion = TEST_SKILL_CONTENT.replace('owner: e2e-test-team', 'owner: global-team')
        const projectVersion = TEST_SKILL_CONTENT.replace('owner: e2e-test-team', 'owner: project-team')

        await writeFile(join(globalSkillsDir, 'test-skill.md'), globalVersion)
        await writeFile(join(projectSkillsDir, 'test-skill.md'), projectVersion)

        const loader = new DzupAgentFileLoader({ paths: makePaths(tierDir) })
        const bundles = await loader.loadSkills()

        // Should deduplicate — only one bundle for test-skill
        expect(bundles).toHaveLength(1)
        expect(bundles[0]!.metadata.owner).toBe('project-team')

        // Matrix should still be buildable from the winning bundle
        const registry = createDefaultSkillRegistry()
        const builder = new SkillCapabilityMatrixBuilder(registry)
        const matrix = builder.buildForSkill(bundles[0]!)
        expect(matrix.skillId).toBe('test-skill')
        expect(Object.keys(matrix.providers)).toHaveLength(7)
      } finally {
        await rm(tierDir, { recursive: true, force: true })
      }
    })
  })
})
