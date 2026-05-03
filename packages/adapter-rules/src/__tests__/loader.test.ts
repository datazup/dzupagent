import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RuleLoader } from '../loader.js'
import type { AdapterRule } from '../types.js'

const exampleRule: AdapterRule = {
  id: 'r1',
  name: 'Example',
  scope: 'project',
  appliesToProviders: ['*'],
  effects: [{ kind: 'prompt_section', purpose: 'persona', content: 'hello' }],
}

describe('RuleLoader', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'adapter-rules-test-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('loads a single rule from a JSON file', async () => {
    const filePath = join(dir, 'single.json')
    await writeFile(filePath, JSON.stringify(exampleRule), 'utf8')

    const rules = await new RuleLoader().loadFile(filePath)
    expect(rules).toHaveLength(1)
    expect(rules[0]?.id).toBe('r1')
  })

  it('loads an array of rules from a JSON file', async () => {
    const filePath = join(dir, 'array.json')
    const second = { ...exampleRule, id: 'r2', name: 'Second' }
    await writeFile(filePath, JSON.stringify([exampleRule, second]), 'utf8')

    const rules = await new RuleLoader().loadFile(filePath)
    expect(rules.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('gracefully skips a malformed JSON file', async () => {
    const filePath = join(dir, 'broken.json')
    await writeFile(filePath, '{ not valid json', 'utf8')

    const rules = await new RuleLoader().loadFile(filePath)
    expect(rules).toEqual([])
    expect(console.warn).toHaveBeenCalled()
  })

  it('skips objects missing required fields', async () => {
    const filePath = join(dir, 'invalid.json')
    // Missing effects, scope, appliesToProviders
    await writeFile(filePath, JSON.stringify({ id: 'x', name: 'x' }), 'utf8')

    const rules = await new RuleLoader().loadFile(filePath)
    expect(rules).toEqual([])
    expect(console.warn).toHaveBeenCalled()
  })

  it('skips rules with invalid scope or provider ids', async () => {
    const filePath = join(dir, 'invalid-scope-provider.json')
    await writeFile(
      filePath,
      JSON.stringify({
        ...exampleRule,
        scope: 'organization',
        appliesToProviders: ['codex', 'unknown-provider'],
      }),
      'utf8',
    )

    const rules = await new RuleLoader().loadFile(filePath)
    expect(rules).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('scope must be one of'))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('supported provider id'))
  })

  it('skips rules with malformed match arrays', async () => {
    const filePath = join(dir, 'invalid-match.json')
    await writeFile(
      filePath,
      JSON.stringify({
        ...exampleRule,
        match: {
          paths: ['apps/api'],
          requestTags: 'security',
        },
      }),
      'utf8',
    )

    const rules = await new RuleLoader().loadFile(filePath)
    expect(rules).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('match.requestTags must be a string array'))
  })

  it('skips rules with unknown effect kinds', async () => {
    const filePath = join(dir, 'unknown-effect.json')
    await writeFile(
      filePath,
      JSON.stringify({
        ...exampleRule,
        effects: [{ kind: 'unknown_effect', content: 'ignored before fix' }],
      }),
      'utf8',
    )

    const rules = await new RuleLoader().loadFile(filePath)
    expect(rules).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('known RuleEffect kind'))
  })

  it.each([
    {
      name: 'prompt_section without content',
      effect: { kind: 'prompt_section', purpose: 'persona' },
      message: 'content must be a non-empty string',
    },
    {
      name: 'prompt_section with invalid purpose',
      effect: { kind: 'prompt_section', purpose: 'brand', content: 'x' },
      message: 'purpose must be one of',
    },
    {
      name: 'require_skill without skill',
      effect: { kind: 'require_skill' },
      message: 'skill must be a non-empty string',
    },
    {
      name: 'prefer_agent without agent',
      effect: { kind: 'prefer_agent' },
      message: 'agent must be a non-empty string',
    },
    {
      name: 'require_approval with invalid target',
      effect: { kind: 'require_approval', target: 'filesystem' },
      message: 'target must be one of',
    },
    {
      name: 'deny_path without path',
      effect: { kind: 'deny_path' },
      message: 'path must be a non-empty string',
    },
    {
      name: 'watch_path without artifactKind',
      effect: { kind: 'watch_path', path: '.codex/' },
      message: 'artifactKind must be a non-empty string',
    },
    {
      name: 'emit_alert with invalid severity',
      effect: { kind: 'emit_alert', on: 'tool:error', severity: 'critical' },
      message: 'severity must be one of',
    },
  ])('skips rules with malformed effect payload: $name', async ({ effect, message }) => {
    const filePath = join(dir, `invalid-effect-${effect.kind}.json`)
    await writeFile(
      filePath,
      JSON.stringify({
        ...exampleRule,
        effects: [effect],
      }),
      'utf8',
    )

    const rules = await new RuleLoader().loadFile(filePath)
    expect(rules).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(message))
  })

  it('loadFromDirectory returns all valid rules from .json files', async () => {
    const subdir = join(dir, 'rules')
    await mkdir(subdir)
    await writeFile(join(subdir, 'a.json'), JSON.stringify(exampleRule), 'utf8')
    await writeFile(
      join(subdir, 'b.json'),
      JSON.stringify([{ ...exampleRule, id: 'r2' }, { ...exampleRule, id: 'r3' }]),
      'utf8',
    )
    // Non-JSON file should be ignored
    await writeFile(join(subdir, 'note.txt'), 'not a rule', 'utf8')
    // Malformed JSON should be skipped silently
    await writeFile(join(subdir, 'bad.json'), '{ broken', 'utf8')

    const rules = await new RuleLoader().loadFromDirectory(subdir)
    const ids = rules.map((r) => r.id).sort()
    expect(ids).toEqual(['r1', 'r2', 'r3'])
  })

  it('loadFromDirectory returns an empty array for a non-existent directory', async () => {
    const missing = join(dir, 'does-not-exist')
    const rules = await new RuleLoader().loadFromDirectory(missing)
    expect(rules).toEqual([])
  })

  it('returns structured diagnostics for invalid rule files', async () => {
    const filePath = join(dir, 'invalid-diagnostic.json')
    await writeFile(
      filePath,
      JSON.stringify({
        ...exampleRule,
        effects: [{ kind: 'deny_path' }],
      }),
      'utf8',
    )

    const result = await new RuleLoader().loadFileWithDiagnostics(filePath)

    expect(result.rules).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_rule',
        source: filePath,
        ruleIndex: 0,
        errors: ['effects[0].path must be a non-empty string'],
      }),
    ])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('returns structured diagnostics for missing directories without warning through the legacy API', async () => {
    const missing = join(dir, 'missing-rules')
    const loader = new RuleLoader()

    await expect(loader.loadFromDirectory(missing)).resolves.toEqual([])
    expect(console.warn).not.toHaveBeenCalled()

    const result = await loader.loadFromDirectoryWithDiagnostics(missing)
    expect(result.rules).toEqual([])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'directory_not_found',
        source: missing,
      }),
    ])
  })
})
