import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ScaffoldEngine } from '../scaffold-engine.js'
import { renderTemplate } from '../template-renderer.js'
import {
  templateRegistry,
  minimalTemplate,
  fullStackTemplate,
  codegenTemplate,
  multiAgentTemplate,
  serverTemplate,
  getTemplate,
  listTemplates,
} from '../templates/index.js'
import type { TemplateType } from '../types.js'

describe('renderTemplate', () => {
  it('replaces {{variable}} placeholders with values', () => {
    const result = renderTemplate('Hello {{name}}, welcome to {{place}}!', {
      name: 'Alice',
      place: 'Wonderland',
    })
    expect(result).toBe('Hello Alice, welcome to Wonderland!')
  })

  it('leaves unknown variables as-is', () => {
    const result = renderTemplate('Hello {{name}}, {{unknown}} here.', {
      name: 'Bob',
    })
    expect(result).toBe('Hello Bob, {{unknown}} here.')
  })

  it('handles empty variables map', () => {
    const result = renderTemplate('No {{vars}} replaced.', {})
    expect(result).toBe('No {{vars}} replaced.')
  })

  it('handles content with no placeholders', () => {
    const result = renderTemplate('plain text', { name: 'ignored' })
    expect(result).toBe('plain text')
  })

  it('replaces multiple occurrences of the same variable', () => {
    const result = renderTemplate('{{x}} and {{x}} again', { x: 'hi' })
    expect(result).toBe('hi and hi again')
  })
})

describe('Template Manifests', () => {
  const templateTypes: TemplateType[] = ['minimal', 'full-stack', 'codegen', 'multi-agent', 'server']

  it('all 5 templates exist in the registry', () => {
    expect(Object.keys(templateRegistry)).toHaveLength(5)
    for (const t of templateTypes) {
      expect(templateRegistry[t]).toBeDefined()
    }
  })

  it('each template has required fields', () => {
    for (const t of templateTypes) {
      const manifest = templateRegistry[t]
      expect(manifest.id).toBe(t)
      expect(manifest.name).toBeTruthy()
      expect(manifest.description).toBeTruthy()
      expect(manifest.files.length).toBeGreaterThan(0)
      expect(Object.keys(manifest.dependencies).length).toBeGreaterThan(0)
    }
  })

  it('each template includes a package.json file', () => {
    for (const t of templateTypes) {
      const manifest = templateRegistry[t]
      const pkgFile = manifest.files.find((f) => f.path === 'package.json')
      expect(pkgFile).toBeDefined()
    }
  })

  it('each template includes a .gitignore file', () => {
    for (const t of templateTypes) {
      const manifest = templateRegistry[t]
      const gitignore = manifest.files.find((f) => f.path === '.gitignore')
      expect(gitignore).toBeDefined()
    }
  })

  it('getTemplate throws for unknown template', () => {
    expect(() => getTemplate('nonexistent' as TemplateType)).toThrow('Unknown template')
  })

  it('listTemplates returns all templates', () => {
    const all = listTemplates()
    expect(all).toHaveLength(5)
  })

  it('specific templates are correctly imported', () => {
    expect(minimalTemplate.id).toBe('minimal')
    expect(fullStackTemplate.id).toBe('full-stack')
    expect(codegenTemplate.id).toBe('codegen')
    expect(multiAgentTemplate.id).toBe('multi-agent')
    expect(serverTemplate.id).toBe('server')
  })
})

describe('ScaffoldEngine', () => {
  let tempDir: string
  let engine: ScaffoldEngine

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-scaffold-'))
    engine = new ScaffoldEngine()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('generates a minimal template project', async () => {
    const result = await engine.generate({
      projectName: 'test-agent',
      template: 'minimal',
      outputDir: tempDir,
    })

    expect(result.template).toBe('minimal')
    expect(result.projectDir).toBe(join(tempDir, 'test-agent'))
    expect(result.filesCreated.length).toBeGreaterThan(0)
    expect(result.filesCreated).toContain('package.json')
    expect(result.filesCreated).toContain('src/index.ts')
  })

  it('creates files on disk with correct content', async () => {
    await engine.generate({
      projectName: 'my-bot',
      template: 'minimal',
      outputDir: tempDir,
    })

    const pkgContent = await readFile(join(tempDir, 'my-bot', 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgContent) as Record<string, unknown>
    expect(pkg['name']).toBe('my-bot')
  })

  it('performs variable interpolation in generated files', async () => {
    await engine.generate({
      projectName: 'cool-agent',
      template: 'minimal',
      outputDir: tempDir,
    })

    const indexContent = await readFile(
      join(tempDir, 'cool-agent', 'src', 'index.ts'),
      'utf-8',
    )
    expect(indexContent).toContain('cool-agent')
    expect(indexContent).not.toContain('{{projectName}}')
  })

  it('generates a full-stack template with server files', async () => {
    const result = await engine.generate({
      projectName: 'full-app',
      template: 'full-stack',
      outputDir: tempDir,
    })

    expect(result.template).toBe('full-stack')
    expect(result.filesCreated).toContain('.env.example')

    const envContent = await readFile(
      join(tempDir, 'full-app', '.env.example'),
      'utf-8',
    )
    expect(envContent).toContain('full-app')
  })

  it('generates a server template with Dockerfile', async () => {
    const result = await engine.generate({
      projectName: 'srv',
      template: 'server',
      outputDir: tempDir,
    })

    expect(result.filesCreated).toContain('Dockerfile')
    const dockerContent = await readFile(
      join(tempDir, 'srv', 'Dockerfile'),
      'utf-8',
    )
    expect(dockerContent).toContain('FROM node:')
    expect(dockerContent).toContain('appuser')
  })

  it('creates nested directories for file paths', async () => {
    const result = await engine.generate({
      projectName: 'nested-test',
      template: 'multi-agent',
      outputDir: tempDir,
    })

    expect(result.filesCreated).toContain('src/agents/planner.ts')
    const plannerContent = await readFile(
      join(tempDir, 'nested-test', 'src', 'agents', 'planner.ts'),
      'utf-8',
    )
    expect(plannerContent).toContain('nested-test')
  })
})
