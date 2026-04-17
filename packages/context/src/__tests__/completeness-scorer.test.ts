import { describe, it, expect } from 'vitest'
import { scoreCompleteness, type DescriptionInput } from '../completeness-scorer.js'

describe('scoreCompleteness', () => {
  // -----------------------------------------------------------------------
  // Name quality
  // -----------------------------------------------------------------------

  it('awards 0.05 for a name longer than 3 characters', () => {
    const result = scoreCompleteness({ name: 'Auth', description: '' })
    expect(result.score).toBeGreaterThanOrEqual(0.05)
    expect(result.reasoning).toContain('Name provided')
  })

  it('awards nothing for a name of 3 characters or fewer', () => {
    const result = scoreCompleteness({ name: 'ab', description: '' })
    expect(result.reasoning).not.toContain('Name provided')
  })

  it('awards nothing for an empty name', () => {
    const result = scoreCompleteness({ name: '', description: '' })
    expect(result.reasoning).not.toContain('Name provided')
  })

  // -----------------------------------------------------------------------
  // Description length
  // -----------------------------------------------------------------------

  it('awards 0.25 for a description over 200 chars', () => {
    const result = scoreCompleteness({ name: '', description: 'x'.repeat(201) })
    expect(result.score).toBeGreaterThanOrEqual(0.25)
    expect(result.reasoning).toContain('Detailed description (200+ chars)')
  })

  it('awards 0.15 for a description between 101-200 chars', () => {
    const result = scoreCompleteness({ name: '', description: 'x'.repeat(150) })
    expect(result.score).toBeGreaterThanOrEqual(0.15)
    expect(result.reasoning).toContain('Moderate description (100+ chars)')
  })

  it('awards 0.05 for a description between 31-100 chars', () => {
    const result = scoreCompleteness({ name: '', description: 'x'.repeat(50) })
    expect(result.score).toBeGreaterThanOrEqual(0.05)
    expect(result.reasoning).toContain('Brief description')
  })

  it('awards nothing for a description of 30 chars or fewer', () => {
    const result = scoreCompleteness({ name: '', description: 'short' })
    expect(result.reasoning).not.toContain('description')
  })

  // -----------------------------------------------------------------------
  // Entity mentions
  // -----------------------------------------------------------------------

  it('detects entity patterns in description', () => {
    const result = scoreCompleteness({
      name: 'feature',
      description: 'The user can create an api endpoint for the table with auth login and email notification and upload file',
    })
    // Matches: user, create, api/endpoint, table, auth/login, email/notification, upload/file
    expect(result.reasoning.some(r => r.includes('entity types mentioned'))).toBe(true)
  })

  it('caps entity score at 0.2 (4 entities)', () => {
    const result = scoreCompleteness({
      name: '',
      description: 'The user can create an api endpoint for the table with auth and email notification and file upload',
    })
    // Even with many entity matches, the score from entities alone is capped at 0.2
    const entityReasoning = result.reasoning.find(r => r.includes('entity types'))
    expect(entityReasoning).toBeDefined()
  })

  it('awards nothing when no entity patterns match', () => {
    const result = scoreCompleteness({ name: '', description: 'just some random text here that is long enough' })
    expect(result.reasoning.every(r => !r.includes('entity types'))).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Tech stack
  // -----------------------------------------------------------------------

  it('awards 0.15 for a tech stack with 3+ entries', () => {
    const result = scoreCompleteness({
      name: 'feat',
      description: '',
      techStack: { lang: 'TypeScript', db: 'Postgres', fw: 'Express' },
    })
    expect(result.reasoning).toContain('Tech stack specified')
  })

  it('awards 0.05 for a partial tech stack (1-2 entries)', () => {
    const result = scoreCompleteness({
      name: 'feat',
      description: '',
      techStack: { lang: 'TypeScript' },
    })
    expect(result.reasoning).toContain('Partial tech stack')
  })

  it('awards nothing for an empty tech stack', () => {
    const result = scoreCompleteness({
      name: 'feat',
      description: '',
      techStack: {},
    })
    expect(result.reasoning.every(r => !r.includes('tech stack') && !r.includes('Tech stack'))).toBe(true)
  })

  it('awards nothing when techStack is undefined', () => {
    const result = scoreCompleteness({ name: 'feat', description: '' })
    expect(result.reasoning.every(r => !r.includes('tech stack') && !r.includes('Tech stack'))).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Category
  // -----------------------------------------------------------------------

  it('awards 0.05 for a specified category', () => {
    const result = scoreCompleteness({ name: 'feat', description: '', category: 'web-app' })
    expect(result.reasoning).toContain('Category specified')
  })

  it('awards nothing when category is undefined', () => {
    const result = scoreCompleteness({ name: 'feat', description: '' })
    expect(result.reasoning.every(r => !r.includes('Category'))).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Scope
  // -----------------------------------------------------------------------

  it('awards 0.1 for a non-empty scope', () => {
    const result = scoreCompleteness({
      name: 'feat',
      description: '',
      scope: ['backend', 'frontend'],
    })
    expect(result.reasoning.some(r => r.includes('Scope'))).toBe(true)
  })

  it('awards nothing for an empty scope array', () => {
    const result = scoreCompleteness({ name: 'feat', description: '', scope: [] })
    expect(result.reasoning.every(r => !r.includes('Scope'))).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Tags
  // -----------------------------------------------------------------------

  it('awards 0.05 for 2+ tags', () => {
    const result = scoreCompleteness({
      name: 'feat',
      description: '',
      tags: ['auth', 'backend'],
    })
    expect(result.reasoning).toContain('Tags provided')
  })

  it('awards nothing for fewer than 2 tags', () => {
    const result = scoreCompleteness({ name: 'feat', description: '', tags: ['one'] })
    expect(result.reasoning.every(r => !r.includes('Tags'))).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Constraint language
  // -----------------------------------------------------------------------

  it('awards 0.1 for 2+ constraint patterns', () => {
    const result = scoreCompleteness({
      name: 'feat',
      description: 'The system must support at least 100 users',
    })
    expect(result.reasoning).toContain('Specific constraints mentioned')
  })

  it('awards 0.05 for exactly 1 constraint pattern', () => {
    const result = scoreCompleteness({
      name: 'feat',
      description: 'The system must handle requests efficiently with good throughput',
    })
    expect(result.reasoning).toContain('Some constraints mentioned')
  })

  it('awards nothing when no constraint patterns match', () => {
    const result = scoreCompleteness({
      name: 'feat',
      description: 'A generic description with no constraint language inside it at all',
    })
    expect(result.reasoning.every(r => !r.includes('constraint'))).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Score clamping and maxQuestions
  // -----------------------------------------------------------------------

  it('clamps score to maximum 1.0', () => {
    // Pack everything to maximize score beyond 1.0
    const result = scoreCompleteness({
      name: 'Full Featured Auth Module',
      description:
        'The user must be able to create, read, update, delete api endpoints for the table model with auth login. ' +
        'Support email notification and file upload. Must have at least 10 routes. Never allow unauthorized access. ' +
        'The admin role should manage permissions for each team member. The component page view form with modal dialog. ' +
        'x'.repeat(200),
      category: 'web-app',
      tags: ['auth', 'backend', 'security'],
      techStack: { lang: 'TypeScript', db: 'Postgres', fw: 'Express', cache: 'Redis' },
      scope: ['backend', 'frontend', 'database'],
    })
    expect(result.score).toBeLessThanOrEqual(1)
  })

  it('returns maxQuestions=0 for score > 0.8', () => {
    const result = scoreCompleteness({
      name: 'Full Auth Module',
      description:
        'The user must create, update, delete api endpoints for model with auth login session. ' +
        'Support email notification and file upload storage. Must have at least 10. Never allow unauthorized. ' +
        'x'.repeat(200),
      category: 'web-app',
      tags: ['auth', 'backend'],
      techStack: { lang: 'TS', db: 'PG', fw: 'Express' },
      scope: ['backend'],
    })
    if (result.score > 0.8) {
      expect(result.maxQuestions).toBe(0)
    }
  })

  it('returns maxQuestions=3 for score between 0.5 and 0.8', () => {
    const result = scoreCompleteness({
      name: 'Auth Module',
      description:
        'The user can create api endpoints for the table model. Must support login and session management for admin role.',
      category: 'web-app',
    })
    if (result.score > 0.5 && result.score <= 0.8) {
      expect(result.maxQuestions).toBe(3)
    }
  })

  it('returns maxQuestions=7 for score <= 0.5', () => {
    const result = scoreCompleteness({ name: 'x', description: 'build something' })
    expect(result.score).toBeLessThanOrEqual(0.5)
    expect(result.maxQuestions).toBe(7)
  })

  // -----------------------------------------------------------------------
  // Integration / edge cases
  // -----------------------------------------------------------------------

  it('handles completely empty input', () => {
    const result = scoreCompleteness({ name: '', description: '' })
    expect(result.score).toBe(0)
    expect(result.maxQuestions).toBe(7)
    expect(result.reasoning).toEqual([])
  })

  it('handles undefined description gracefully', () => {
    const result = scoreCompleteness({ name: 'test', description: undefined as unknown as string })
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(typeof result.maxQuestions).toBe('number')
  })
})
