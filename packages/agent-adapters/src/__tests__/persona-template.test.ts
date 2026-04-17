import { describe, it, expect } from 'vitest'

import {
  resolvePersonaTemplate,
  SystemPromptBuilder,
  type PersonaTemplateContext,
} from '../prompts/system-prompt-builder.js'

describe('resolvePersonaTemplate', () => {
  it('returns template unchanged when no placeholders present', () => {
    expect(resolvePersonaTemplate('Hello world', {})).toBe('Hello world')
  })

  it('resolves persona.name', () => {
    const out = resolvePersonaTemplate('Hello {{persona.name}}', {
      persona: { name: 'Claude' },
    })
    expect(out).toBe('Hello Claude')
  })

  it('resolves persona.id', () => {
    const out = resolvePersonaTemplate('ID: {{persona.id}}', {
      persona: { id: 'p-123' },
    })
    expect(out).toBe('ID: p-123')
  })

  it('resolves persona.role', () => {
    const out = resolvePersonaTemplate('Role: {{persona.role}}', {
      persona: { role: 'architect' },
    })
    expect(out).toBe('Role: architect')
  })

  it('resolves task.description', () => {
    const out = resolvePersonaTemplate('Task: {{task.description}}', {
      task: { description: 'refactor code' },
    })
    expect(out).toBe('Task: refactor code')
  })

  it('resolves run.depth as string', () => {
    const out = resolvePersonaTemplate('Depth: {{run.depth}}', {
      run: { depth: 3 },
    })
    expect(out).toBe('Depth: 3')
  })

  it('resolves run.branchId and run.rootRunId', () => {
    const out = resolvePersonaTemplate(
      'Branch: {{run.branchId}} Root: {{run.rootRunId}}',
      {
        run: { branchId: 'br-1', rootRunId: 'root-1' },
      },
    )
    expect(out).toBe('Branch: br-1 Root: root-1')
  })

  it('resolves parent.output', () => {
    const out = resolvePersonaTemplate('Parent: {{parent.output}}', {
      parent: { output: 'previous result' },
    })
    expect(out).toBe('Parent: previous result')
  })

  it('leaves unresolved placeholders as-is', () => {
    const out = resolvePersonaTemplate('Unknown: {{foo.bar}}', {})
    expect(out).toBe('Unknown: {{foo.bar}}')
  })

  it('merges extra variables', () => {
    const out = resolvePersonaTemplate('{{foo}} - {{bar}}', {
      extra: { foo: 'hello', bar: 'world' },
    })
    expect(out).toBe('hello - world')
  })

  it('extra variables take precedence over structured context when keys overlap', () => {
    const ctx: PersonaTemplateContext = {
      persona: { name: 'defaultName' },
      extra: { 'persona.name': 'overrideName' },
    }
    const out = resolvePersonaTemplate('{{persona.name}}', ctx)
    expect(out).toBe('overrideName')
  })

  it('handles multiple placeholders in a single string', () => {
    const out = resolvePersonaTemplate(
      '{{persona.name}} is a {{persona.role}} working on {{task.description}}',
      {
        persona: { name: 'Alice', role: 'engineer' },
        task: { description: 'code review' },
      },
    )
    expect(out).toBe('Alice is a engineer working on code review')
  })

  it('handles empty context gracefully', () => {
    const out = resolvePersonaTemplate('{{persona.name}}', {})
    expect(out).toBe('{{persona.name}}')
  })

  it('trims whitespace in placeholder keys', () => {
    const out = resolvePersonaTemplate('{{ persona.name }}', {
      persona: { name: 'Alice' },
    })
    expect(out).toBe('Alice')
  })

  it('handles persona with partial fields', () => {
    const out = resolvePersonaTemplate(
      '{{persona.name}} {{persona.role}}',
      { persona: { name: 'Alice' } }, // role missing
    )
    expect(out).toBe('Alice {{persona.role}}')
  })

  it('handles run with partial fields', () => {
    const out = resolvePersonaTemplate(
      '{{run.depth}} {{run.branchId}}',
      { run: { depth: 0 } }, // branchId missing
    )
    expect(out).toBe('0 {{run.branchId}}')
  })

  it('handles task.description = undefined gracefully', () => {
    const out = resolvePersonaTemplate('{{task.description}}', {
      task: {},
    })
    expect(out).toBe('{{task.description}}')
  })

  it('handles parent without output', () => {
    const out = resolvePersonaTemplate('{{parent.output}}', {
      parent: {},
    })
    expect(out).toBe('{{parent.output}}')
  })
})

describe('SystemPromptBuilder.fromPersonaTemplate', () => {
  it('creates a builder with resolved template', () => {
    const builder = SystemPromptBuilder.fromPersonaTemplate(
      'You are {{persona.name}}, a {{persona.role}}.',
      {
        persona: { name: 'Alice', role: 'architect' },
      },
    )
    expect(builder.rawText).toBe('You are Alice, a architect.')
  })

  it('respects options when passed', () => {
    const builder = SystemPromptBuilder.fromPersonaTemplate(
      'Hello {{persona.name}}',
      { persona: { name: 'Bob' } },
      { claudeMode: 'replace' },
    )
    const payload = builder.buildFor('claude')
    expect(payload).toBe('Hello Bob')
  })

  it('defaults to append mode when options not passed', () => {
    const builder = SystemPromptBuilder.fromPersonaTemplate(
      'Greetings {{persona.name}}',
      { persona: { name: 'C' } },
    )
    const payload = builder.buildFor('claude')
    expect(typeof payload).toBe('object')
    if (typeof payload === 'object' && payload !== null) {
      expect((payload as { type: string }).type).toBe('preset')
    }
  })

  it('throws if resolved template is empty', () => {
    expect(() =>
      SystemPromptBuilder.fromPersonaTemplate('', {}),
    ).toThrow('non-empty string')
  })

  it('works with extra variables', () => {
    const builder = SystemPromptBuilder.fromPersonaTemplate(
      '{{customVar}} world',
      { extra: { customVar: 'Hello' } },
    )
    expect(builder.rawText).toBe('Hello world')
  })
})
