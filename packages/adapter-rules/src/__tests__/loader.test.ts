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
})
