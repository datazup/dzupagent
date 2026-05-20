/**
 * Versioned-template frontmatter + required-section validation
 * (Stage 1.5 follow-up). See `../template.ts`.
 */
import { describe, expect, it } from 'vitest'

import { parseTemplate } from '../template.js'

describe('parseTemplate — happy path', () => {
  it('parses a valid template with frontmatter and all required sections', () => {
    const source = `---
id: planning-pipeline
version: 1
profile: planning-fast
schema: plan.v1
requiredSections: [Goal, Constraints, Output Format]
---
## Goal
Identify the next action.

## Constraints
- No network calls.
- Token budget: 4k.

## Output Format
JSON with keys plan, rationale.
`
    const result = parseTemplate(source)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.template.id).toBe('planning-pipeline')
    expect(result.template.version).toBe(1)
    expect(result.template.profile).toBe('planning-fast')
    expect(result.template.schema).toBe('plan.v1')
    expect(result.template.requiredSections).toEqual([
      'Goal',
      'Constraints',
      'Output Format',
    ])
    expect(Object.keys(result.template.sections)).toEqual([
      'Goal',
      'Constraints',
      'Output Format',
    ])
    expect(result.template.sections.Goal).toContain('Identify the next action.')
    expect(result.template.sections.Constraints).toContain('No network calls.')
    expect(result.warnings).toEqual([])
  })

  it('accepts a minimal template with no optional fields', () => {
    const source = `---
id: minimal
version: 1
requiredSections: [Body]
---
## Body
Hello.
`
    const result = parseTemplate(source)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.template.profile).toBeUndefined()
    expect(result.template.schema).toBeUndefined()
    expect(result.template.sections.Body).toBe('Hello.')
  })
})

describe('parseTemplate — MISSING_REQUIRED_SECTION', () => {
  it('reports every missing required section by name', () => {
    const source = `---
id: planner
version: 2
requiredSections: [Goal, Constraints, Output Format]
---
## Goal
Plan stuff.
`
    const result = parseTemplate(source)
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('MISSING_REQUIRED_SECTION')
    expect(result.errors[0]?.message).toContain('"Constraints"')
    expect(result.errors[0]?.message).toContain('"Output Format"')
    // Goal is present and must NOT appear in the missing list.
    expect(result.errors[0]?.message).not.toContain('"Goal"')
  })
})

describe('parseTemplate — INVALID_TEMPLATE_FRONTMATTER', () => {
  it('rejects a source with no frontmatter at all', () => {
    const source = `# Just a markdown file
no frontmatter here.
`
    const result = parseTemplate(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.code).toBe('INVALID_TEMPLATE_FRONTMATTER')
    expect(result.errors[0]?.message).toContain('`---`')
  })

  it('rejects unterminated frontmatter', () => {
    const source = `---
id: foo
version: 1
## still in frontmatter
`
    const result = parseTemplate(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.code).toBe('INVALID_TEMPLATE_FRONTMATTER')
  })

  it('rejects malformed YAML inside the frontmatter', () => {
    // Tabs trigger an INVALID_YAML_SUBSET inside parseYamlSubset which we
    // translate to INVALID_TEMPLATE_FRONTMATTER.
    const source = `---
id: foo
\tversion: 1
requiredSections: [A]
---
## A
body
`
    const result = parseTemplate(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.code).toBe('INVALID_TEMPLATE_FRONTMATTER')
    expect(result.errors[0]?.message.toLowerCase()).toContain('yaml')
  })

  it('rejects a non-kebab-case id', () => {
    const source = `---
id: NotKebab
version: 1
requiredSections: []
---
`
    const result = parseTemplate(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.code).toBe('INVALID_TEMPLATE_FRONTMATTER')
    expect(result.errors[0]?.message).toContain('kebab-case')
  })

  it('rejects a non-integer version', () => {
    const source = `---
id: foo
version: 1.5
requiredSections: []
---
`
    const result = parseTemplate(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.code).toBe('INVALID_TEMPLATE_FRONTMATTER')
    expect(result.errors[0]?.message).toContain('version')
  })
})

describe('parseTemplate — UNKNOWN_FRONTMATTER_KEY warnings', () => {
  it('emits a warning (not an error) for unknown forward-compat keys', () => {
    const source = `---
id: foo
version: 1
requiredSections: [A]
experimentalThing: yes
---
## A
body
`
    const result = parseTemplate(source)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.code).toBe('UNKNOWN_FRONTMATTER_KEY')
    expect(result.warnings[0]?.message).toContain('experimentalThing')
  })
})

describe('parseTemplate — profile threads cleanly to a ProfileRef', () => {
  /**
   * Downstream Stage 3 (`semantic-profile-resolver.ts`) consumes
   * profile refs as plain kebab-case strings. We assert that a
   * `profile:` frontmatter value lands in `template.profile` exactly
   * as authored so the resolver can hand it straight to its registry.
   */
  it('exposes the profile field as a plain kebab-case string', () => {
    const source = `---
id: planning-pipeline
version: 1
profile: planning-fast
requiredSections: [Goal]
---
## Goal
.
`
    const result = parseTemplate(source)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.template.profile).toBe('planning-fast')
    // Downstream resolver shape: simulate by reading the field
    // directly — no extra parsing should be required.
    const profileRef: string | undefined = result.template.profile
    expect(typeof profileRef).toBe('string')
    expect(profileRef).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('rejects a profile value that is not kebab-case', () => {
    const source = `---
id: foo
version: 1
profile: NotKebab
requiredSections: []
---
`
    const result = parseTemplate(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.code).toBe('INVALID_TEMPLATE_FRONTMATTER')
    expect(result.errors[0]?.message).toContain('profile')
  })
})
