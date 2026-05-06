import { describe, it, expect, vi } from 'vitest'
import { createEventBus, type DzupEvent, type DzupEventBus } from '@dzupagent/core'
import {
  findDuplicateSpecialistAssignmentsWithoutIds,
  formatDuplicateSpecialistAssignmentIdMessage,
  guardDuplicateSpecialistAssignmentIds,
} from '../orchestration/assignment-validator.js'
import { OrchestrationError } from '../orchestration/orchestration-error.js'

interface CapturingBus {
  bus: DzupEventBus
  captured: DzupEvent[]
}

function createCapturingBus(): CapturingBus {
  const bus = createEventBus()
  const captured: DzupEvent[] = []
  bus.onAny((event) => {
    captured.push(event)
  })
  return { bus, captured }
}

describe('findDuplicateSpecialistAssignmentsWithoutIds', () => {
  it('returns no warnings when every specialist appears once', () => {
    const warnings = findDuplicateSpecialistAssignmentsWithoutIds([
      { specialistId: 'a' },
      { specialistId: 'b' },
      { specialistId: 'c' },
    ])
    expect(warnings).toEqual([])
  })

  it('returns no warnings when duplicates each have stable ids', () => {
    const warnings = findDuplicateSpecialistAssignmentsWithoutIds([
      { specialistId: 'db', id: 'task-1' },
      { specialistId: 'db', id: 'task-2' },
    ])
    expect(warnings).toEqual([])
  })

  it('flags duplicates when at least one assignment is missing an id', () => {
    const warnings = findDuplicateSpecialistAssignmentsWithoutIds([
      { specialistId: 'db', id: 'task-1' },
      { specialistId: 'db' },
      { specialistId: 'api' },
      { specialistId: 'db', id: '' },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      specialistId: 'db',
      assignmentIndexes: [0, 1, 3],
      missingAssignmentIdIndexes: [1, 3],
    })
  })

  it('treats empty-string ids as missing', () => {
    const warnings = findDuplicateSpecialistAssignmentsWithoutIds([
      { specialistId: 'ui', id: '' },
      { specialistId: 'ui', id: '' },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.missingAssignmentIdIndexes).toEqual([0, 1])
  })
})

describe('formatDuplicateSpecialistAssignmentIdMessage', () => {
  it('renders a single offender as one cluster', () => {
    const msg = formatDuplicateSpecialistAssignmentIdMessage([
      {
        specialistId: 'db',
        assignmentIndexes: [0, 2],
        missingAssignmentIdIndexes: [2],
      },
    ])
    expect(msg).toContain('db at indexes 0, 2')
    expect(msg).toContain('missing IDs at 2')
    expect(msg).toContain('TaskAssignment.id')
  })

  it('joins multiple offenders with semicolons', () => {
    const msg = formatDuplicateSpecialistAssignmentIdMessage([
      { specialistId: 'db', assignmentIndexes: [0, 1], missingAssignmentIdIndexes: [0] },
      { specialistId: 'api', assignmentIndexes: [2, 3], missingAssignmentIdIndexes: [3] },
    ])
    expect(msg).toContain('db at indexes 0, 1')
    expect(msg).toContain('api at indexes 2, 3')
    expect(msg.split(';').length).toBeGreaterThanOrEqual(2)
  })
})

describe('guardDuplicateSpecialistAssignmentIds', () => {
  it("is a no-op in 'allow' mode even when duplicates lack ids", () => {
    const { bus, captured } = createCapturingBus()
    expect(() =>
      guardDuplicateSpecialistAssignmentIds(
        [{ specialistId: 'db' }, { specialistId: 'db' }],
        'allow',
        bus,
      ),
    ).not.toThrow()
    expect(captured).toEqual([])
  })

  it("emits supervisor:duplicate_specialist_assignment_ids in 'warn' mode", () => {
    const { bus, captured } = createCapturingBus()
    guardDuplicateSpecialistAssignmentIds(
      [{ specialistId: 'db' }, { specialistId: 'db' }, { specialistId: 'api' }],
      'warn',
      bus,
    )
    const warnEvent = captured.find(
      (e) => e.type === 'supervisor:duplicate_specialist_assignment_ids',
    )
    expect(warnEvent).toBeDefined()
    expect(warnEvent).toMatchObject({
      mode: 'warn',
      duplicateSpecialists: [
        expect.objectContaining({ specialistId: 'db' }),
      ],
    })
  })

  it("throws OrchestrationError in 'strict' mode and surfaces details", () => {
    const { bus, captured } = createCapturingBus()
    expect(() =>
      guardDuplicateSpecialistAssignmentIds(
        [{ specialistId: 'db' }, { specialistId: 'db' }],
        'strict',
        bus,
      ),
    ).toThrow(OrchestrationError)
    // strict throws before any warn event is emitted
    expect(
      captured.find((e) => e.type === 'supervisor:duplicate_specialist_assignment_ids'),
    ).toBeUndefined()
  })

  it('emits nothing when all duplicates have stable ids regardless of mode', () => {
    const { bus, captured } = createCapturingBus()
    expect(() =>
      guardDuplicateSpecialistAssignmentIds(
        [
          { specialistId: 'db', id: 'a' },
          { specialistId: 'db', id: 'b' },
        ],
        'strict',
        bus,
      ),
    ).not.toThrow()
    expect(captured).toEqual([])
  })

  it('tolerates a missing event bus in warn mode', () => {
    const emitSpy = vi.fn()
    expect(() =>
      guardDuplicateSpecialistAssignmentIds(
        [{ specialistId: 'db' }, { specialistId: 'db' }],
        'warn',
        undefined,
      ),
    ).not.toThrow()
    expect(emitSpy).not.toHaveBeenCalled()
  })
})
