import { describe, expect, it } from 'vitest'

import { SkillProjector } from '../skills/skill-projector.js'

const skills = [
  {
    id: 'sql-gen',
    name: 'SQL Generator',
    description: 'Generates SQL queries from natural language',
    instructions: 'A very long body of instructions that should NOT appear in metadata mode. '.repeat(40),
    requiredTools: ['execute_sql', 'inspect_schema'],
    tags: ['database', 'sql'],
  },
  {
    id: 'ui-design',
    name: 'UI Designer',
    description: 'Produces React component scaffolds',
    instructions: 'Long UI design instructions that should also be omitted. '.repeat(40),
    requiredTools: ['write_file'],
    tags: ['frontend'],
  },
]

describe('SkillProjector progressive disclosure (P3)', () => {
  it('full mode emits the long instructions', () => {
    const projector = new SkillProjector()
    const projection = projector.project(skills, 'claude', { loadMode: 'full' })
    expect(projection.systemPromptSection).toContain('A very long body of instructions')
    expect(projection.skillCount).toBe(2)
  })

  it('metadata mode omits instructions and points the agent at expand_skill', () => {
    const projector = new SkillProjector()
    const projection = projector.project(skills, 'claude', { loadMode: 'metadata' })

    expect(projection.systemPromptSection).not.toContain('A very long body of instructions')
    expect(projection.systemPromptSection).not.toContain('Long UI design instructions')
    expect(projection.systemPromptSection).toContain('expand_skill')
    expect(projection.systemPromptSection).toContain('SQL Generator')
    expect(projection.systemPromptSection).toContain('id: `sql-gen`')
    expect(projection.systemPromptSection).toContain('Triggers: database, sql')
    expect(projection.systemPromptSection).toContain('Required tools: execute_sql, inspect_schema')
  })

  it('metadata mode is dramatically smaller than full mode', () => {
    const projector = new SkillProjector()
    const fullLen = projector.project(skills, 'claude', { loadMode: 'full' }).systemPromptSection.length
    const metaLen = projector.project(skills, 'claude', { loadMode: 'metadata' }).systemPromptSection.length
    expect(metaLen).toBeLessThan(fullLen / 2)
  })

  it('expand() returns a single skill formatted for the provider', () => {
    const projector = new SkillProjector()
    const block = projector.expand(skills[0]!, 'claude')
    expect(block).toContain('SQL Generator')
    expect(block).toContain('A very long body of instructions')
  })

  it('still preserves required tools across modes', () => {
    const projector = new SkillProjector()
    const full = projector.project(skills, 'gemini', { loadMode: 'full' })
    const meta = projector.project(skills, 'gemini', { loadMode: 'metadata' })
    expect(full.requiredTools).toEqual(meta.requiredTools)
    expect(meta.requiredTools).toContain('execute_sql')
  })
})
