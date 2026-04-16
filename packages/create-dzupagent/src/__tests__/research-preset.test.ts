import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getPreset } from '../presets.js'
import { ScaffoldEngine } from '../scaffold-engine.js'
import { researchTemplate } from '../templates/index.js'

describe('research preset', () => {
  it('PRESETS["research"] exists and requires ANTHROPIC_API_KEY', () => {
    const preset = getPreset('research')
    expect(preset).toBeDefined()
    expect(preset!.name).toBe('research')
    expect(preset!.template).toBe('research')
    expect(preset!.description).toContain('Research')

    // The research template .env.example should contain ANTHROPIC_API_KEY
    const envFile = researchTemplate.files.find((f) => f.path === '.env.example')
    expect(envFile).toBeDefined()
    expect(envFile!.templateContent).toContain('ANTHROPIC_API_KEY')
  })

  describe('scaffolding', () => {
    let tempDir: string
    let engine: ScaffoldEngine

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'dzup-research-'))
      engine = new ScaffoldEngine()
    })

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true })
    })

    it('creates the expected files (agent.ts, server.ts, .env.example, package.json)', async () => {
      const result = await engine.generate({
        projectName: 'my-research',
        template: 'research',
        outputDir: tempDir,
      })

      expect(result.filesCreated).toContain('src/agent.ts')
      expect(result.filesCreated).toContain('src/server.ts')
      expect(result.filesCreated).toContain('.env.example')
      expect(result.filesCreated).toContain('package.json')
      expect(result.filesCreated).toContain('tsconfig.json')

      // Verify agent.ts exists on disk and contains interpolated name
      const agentContent = await readFile(
        join(tempDir, 'my-research', 'src', 'agent.ts'),
        'utf-8',
      )
      expect(agentContent).toContain('my-research')
      expect(agentContent).not.toContain('{{projectName}}')

      // Verify server.ts exists on disk
      const serverContent = await readFile(
        join(tempDir, 'my-research', 'src', 'server.ts'),
        'utf-8',
      )
      expect(serverContent).toContain('createResearchAgent')
    })

    it('package.json template contains {{projectName}} that gets replaced', async () => {
      // Verify the raw template has the placeholder
      const pkgTemplate = researchTemplate.files.find((f) => f.path === 'package.json')
      expect(pkgTemplate).toBeDefined()
      expect(pkgTemplate!.templateContent).toContain('{{projectName}}')

      // Verify after scaffolding it is replaced
      await engine.generate({
        projectName: 'replaced-name',
        template: 'research',
        outputDir: tempDir,
      })

      const pkgRaw = await readFile(
        join(tempDir, 'replaced-name', 'package.json'),
        'utf-8',
      )
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>
      expect(pkg['name']).toBe('replaced-name')
      expect(pkgRaw).not.toContain('{{projectName}}')
    })
  })
})
