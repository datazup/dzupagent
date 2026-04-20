/**
 * Unit tests for lower-skill-chain Stage 4 lowerer.
 *
 * Gold-file test: a 3-action sequence (one action with personaRef) is lowered
 * to a SkillChain with 3 steps. Uses InMemoryDomainToolRegistry from
 * @dzupagent/app-tools as the fixture resolver, adapted into a ToolResolver
 * (same pattern as semantic.test.ts).
 */

import type {
  ActionNode,
  FlowNode,
  ResolvedTool,
  SequenceNode,
  ToolResolver,
} from '@dzupagent/flow-ast'
import type { SkillChain } from '@dzupagent/core'
import { InMemoryDomainToolRegistry } from '@dzupagent/app-tools'
import { describe, expect, it } from 'vitest'

import { lowerSkillChain } from '../src/lower/lower-skill-chain.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a ToolResolver backed by InMemoryDomainToolRegistry. */
function makeResolver(skillNames: string[]): ToolResolver {
  const registry = new InMemoryDomainToolRegistry()
  for (const name of skillNames) {
    const namespace = name.split('.')[0] ?? name
    registry.register({
      name,
      description: `test skill ${name}`,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      permissionLevel: 'read',
      sideEffects: [],
      namespace,
    })
  }
  return {
    resolve(ref: string): ResolvedTool | null {
      const def = registry.get(ref)
      if (!def) return null
      return { ref, kind: 'skill', inputSchema: def.inputSchema, handle: def }
    },
    listAvailable: () => registry.list().map((t) => t.name),
  }
}

const action = (toolRef: string, personaRef?: string): ActionNode => ({
  type: 'action',
  toolRef,
  input: {},
  ...(personaRef !== undefined ? { personaRef } : {}),
})

const sequence = (...nodes: FlowNode[]): SequenceNode => ({ type: 'sequence', nodes })

/**
 * Build the `resolved` side-table from a ToolResolver and a list of
 * { nodePath, toolRef } pairs — mirrors how Stage 3 populates the map.
 */
function buildResolved(
  resolver: ToolResolver,
  entries: Array<{ nodePath: string; toolRef: string }>,
): Map<string, ResolvedTool> {
  const map = new Map<string, ResolvedTool>()
  for (const { nodePath, toolRef } of entries) {
    const rt = resolver.resolve(toolRef)
    if (rt !== null) {
      map.set(nodePath, rt)
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Gold-file test: 3-action sequence, one action with personaRef
// ---------------------------------------------------------------------------

describe('lowerSkillChain', () => {
  it('gold-file: 3-action sequence lowers to SkillChain with 3 steps', () => {
    const resolver = makeResolver(['pm.plan_sprint', 'pm.assign_tasks', 'pm.notify_team'])

    // AST: sequence of 3 actions; the second has a personaRef
    const ast = sequence(
      action('pm.plan_sprint'),
      action('pm.assign_tasks', 'pm.lead'),
      action('pm.notify_team'),
    )

    // Side-table as Stage 3 semantic would produce
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.nodes[0]', toolRef: 'pm.plan_sprint' },
      { nodePath: 'root.nodes[1]', toolRef: 'pm.assign_tasks' },
      { nodePath: 'root.nodes[2]', toolRef: 'pm.notify_team' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'sprint-workflow' })

    // Shape assertions
    expect(artifact.name).toBe('sprint-workflow')
    expect(artifact.steps).toHaveLength(3)

    expect(artifact.steps[0]).toEqual<SkillChain['steps'][number]>({
      skillName: 'pm.plan_sprint',
    })
    expect(artifact.steps[1]).toEqual<SkillChain['steps'][number]>({
      skillName: 'pm.assign_tasks',
    })
    expect(artifact.steps[2]).toEqual<SkillChain['steps'][number]>({
      skillName: 'pm.notify_team',
    })

    // No warnings expected for a well-formed 3-action sequence
    expect(warnings).toEqual([])
  })

  it('default chain name is "flow" when name is not provided', () => {
    const resolver = makeResolver(['tools.do_thing'])
    const ast = action('tools.do_thing')
    const resolved = buildResolved(resolver, [{ nodePath: 'root', toolRef: 'tools.do_thing' }])

    const { artifact } = lowerSkillChain({ ast, resolved })

    expect(artifact.name).toBe('flow')
  })

  it('top-level action (no sequence wrapper) produces a single-step chain', () => {
    const resolver = makeResolver(['svc.run'])
    const ast = action('svc.run')
    const resolved = buildResolved(resolver, [{ nodePath: 'root', toolRef: 'svc.run' }])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'single-step' })

    expect(artifact.steps).toHaveLength(1)
    expect(artifact.steps[0]).toEqual({ skillName: 'svc.run' })
    expect(warnings).toEqual([])
  })

  it('single-child sequence emits a redundancy warning', () => {
    const resolver = makeResolver(['svc.run'])
    const ast = sequence(action('svc.run'))
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.nodes[0]', toolRef: 'svc.run' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'wrapped' })

    expect(artifact.steps).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/redundant single-child sequence/i)
    expect(warnings[0]).toContain('"root"')
  })

  it('unresolved action emits warning and uses toolRef as skillName', () => {
    const resolver = makeResolver([])
    const ast = action('unknown.tool')
    // Deliberately empty resolved map — simulates a semantic-stage miss
    const resolved = new Map<string, ResolvedTool>()

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'partial' })

    expect(artifact.steps).toHaveLength(1)
    expect(artifact.steps[0]?.skillName).toBe('unknown.tool')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"unknown.tool"')
    expect(warnings[0]).toContain('"root"')
  })

  it('non-skill resolved tool emits warning and uses ref as skillName', () => {
    const ast = action('agent.orchestrate')
    const resolved = new Map<string, ResolvedTool>([
      [
        'root',
        {
          ref: 'agent.orchestrate',
          kind: 'agent', // NOT 'skill'
          inputSchema: {},
          handle: { agentId: 'agent-1' },
        },
      ],
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'agent-chain' })

    expect(artifact.steps).toHaveLength(1)
    expect(artifact.steps[0]?.skillName).toBe('agent.orchestrate')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"agent"')
    expect(warnings[0]).toContain('"skill"')
  })

  it('throws a developer error when router contract is violated (for_each node)', () => {
    // for_each is pipeline-only per the router contract — it must throw here.
    const ast: FlowNode = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [action('svc.run')],
    }
    const resolved = new Map<string, ResolvedTool>()

    expect(() => lowerSkillChain({ ast, resolved, name: 'bad' })).toThrow(
      /for_each/i,
    )
  })

  // -------------------------------------------------------------------------
  // Wave 12 parity-rewrite: best-effort degradation for non-action variants
  // -------------------------------------------------------------------------

  it('branch: lowers to sequential then+else and warns about dropped predicate', () => {
    const resolver = makeResolver(['svc.a', 'svc.b', 'svc.c'])
    const ast: FlowNode = {
      type: 'branch',
      condition: 'ctx.ready === true',
      then: [action('svc.a'), action('svc.b')],
      else: [action('svc.c')],
    }
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.then[0]', toolRef: 'svc.a' },
      { nodePath: 'root.then[1]', toolRef: 'svc.b' },
      { nodePath: 'root.else[0]', toolRef: 'svc.c' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'branched' })

    // Then-body comes first, then else-body, inline sequentially.
    expect(artifact.steps.map((s) => s.skillName)).toEqual(['svc.a', 'svc.b', 'svc.c'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/branch/i)
    expect(warnings[0]).toMatch(/predicate is dropped/i)
    expect(warnings[0]).toContain('ctx.ready === true')
  })

  it('branch without else: lowers to then-only and still warns', () => {
    const resolver = makeResolver(['svc.a'])
    const ast: FlowNode = {
      type: 'branch',
      condition: 'flag',
      then: [action('svc.a')],
    }
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.then[0]', toolRef: 'svc.a' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'no-else' })

    expect(artifact.steps.map((s) => s.skillName)).toEqual(['svc.a'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/branch/i)
  })

  it('parallel: lowers to sequential concatenation and warns about fork/join loss', () => {
    const resolver = makeResolver(['svc.a', 'svc.b', 'svc.c', 'svc.d'])
    const ast: FlowNode = {
      type: 'parallel',
      branches: [
        [action('svc.a'), action('svc.b')],
        [action('svc.c')],
        [action('svc.d')],
      ],
    }
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.branches[0][0]', toolRef: 'svc.a' },
      { nodePath: 'root.branches[0][1]', toolRef: 'svc.b' },
      { nodePath: 'root.branches[1][0]', toolRef: 'svc.c' },
      { nodePath: 'root.branches[2][0]', toolRef: 'svc.d' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'par' })

    expect(artifact.steps.map((s) => s.skillName)).toEqual([
      'svc.a',
      'svc.b',
      'svc.c',
      'svc.d',
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/parallel/i)
    expect(warnings[0]).toMatch(/fork\/join/i)
    expect(warnings[0]).toContain('3 branches')
  })

  it('approval: onApprove body inlined with suspendBefore on first step; onReject dropped with warning', () => {
    const resolver = makeResolver(['svc.a', 'svc.b', 'svc.rollback'])
    const ast: FlowNode = {
      type: 'approval',
      question: 'Proceed with deploy?',
      onApprove: [action('svc.a'), action('svc.b')],
      onReject: [action('svc.rollback')],
    }
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.onApprove[0]', toolRef: 'svc.a' },
      { nodePath: 'root.onApprove[1]', toolRef: 'svc.b' },
      { nodePath: 'root.onReject[0]', toolRef: 'svc.rollback' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'approval' })

    expect(artifact.steps).toHaveLength(2)
    expect(artifact.steps[0]).toEqual<SkillChain['steps'][number]>({
      skillName: 'svc.a',
      suspendBefore: true,
    })
    expect(artifact.steps[1]).toEqual<SkillChain['steps'][number]>({
      skillName: 'svc.b',
    })

    // Exactly one warning about the dropped onReject body.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/onReject body dropped/i)
    expect(warnings[0]).toContain('1 reject step')
  })

  it('approval without onReject: inlines onApprove with suspendBefore and emits no warning', () => {
    const resolver = makeResolver(['svc.a'])
    const ast: FlowNode = {
      type: 'approval',
      question: 'OK?',
      onApprove: [action('svc.a')],
    }
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.onApprove[0]', toolRef: 'svc.a' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'approval-bare' })

    expect(artifact.steps).toHaveLength(1)
    expect(artifact.steps[0]?.suspendBefore).toBe(true)
    expect(warnings).toEqual([])
  })

  it('approval with empty onApprove: emits suspend-hint-skipped warning', () => {
    // Wrapping in a sequence so the chain is non-empty and does not fail the
    // "no action nodes" invariant.
    const resolver = makeResolver(['svc.after'])
    const ast: FlowNode = sequence(
      { type: 'approval', question: 'Go?', onApprove: [] },
      action('svc.after'),
    )
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.nodes[1]', toolRef: 'svc.after' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'empty-approve' })

    expect(artifact.steps).toHaveLength(1)
    expect(artifact.steps[0]).toEqual({ skillName: 'svc.after' })
    expect(warnings.some((w) => /suspend hint skipped/i.test(w))).toBe(true)
  })

  it('clarification: emits a synthetic __clarification__ suspend step and warns', () => {
    const ast: FlowNode = {
      type: 'clarification',
      question: 'Which environment?',
    }
    const resolved = new Map<string, ResolvedTool>()

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'clarify' })

    expect(artifact.steps).toHaveLength(1)
    const step = artifact.steps[0]
    expect(step?.skillName.startsWith('__clarification__')).toBe(true)
    expect(step?.skillName).toContain('which_environment')
    expect(step?.suspendBefore).toBe(true)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/clarification/i)
    expect(warnings[0]).toMatch(/synthetic suspend/i)
  })

  it('clarification with non-ASCII question: slugifies to "unspecified" fallback', () => {
    const ast: FlowNode = { type: 'clarification', question: '???' }
    const resolved = new Map<string, ResolvedTool>()

    const { artifact } = lowerSkillChain({ ast, resolved, name: 'clarify-empty' })

    expect(artifact.steps).toHaveLength(1)
    expect(artifact.steps[0]?.skillName).toBe('__clarification__unspecified')
    expect(artifact.steps[0]?.suspendBefore).toBe(true)
  })

  it('persona: inlines body and warns that persona metadata is lost', () => {
    const resolver = makeResolver(['svc.a', 'svc.b'])
    const ast: FlowNode = {
      type: 'persona',
      personaId: 'pm.lead',
      body: [action('svc.a'), action('svc.b')],
    }
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.body[0]', toolRef: 'svc.a' },
      { nodePath: 'root.body[1]', toolRef: 'svc.b' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'persona' })

    expect(artifact.steps.map((s) => s.skillName)).toEqual(['svc.a', 'svc.b'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/persona/i)
    expect(warnings[0]).toContain('pm.lead')
  })

  it('route: inlines body and warns that routing metadata is lost', () => {
    const resolver = makeResolver(['svc.a'])
    const ast: FlowNode = {
      type: 'route',
      strategy: 'fixed-provider',
      provider: 'openai',
      body: [action('svc.a')],
    }
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.body[0]', toolRef: 'svc.a' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'routed' })

    expect(artifact.steps.map((s) => s.skillName)).toEqual(['svc.a'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/route/i)
    expect(warnings[0]).toContain('fixed-provider')
    expect(warnings[0]).toContain('openai')
  })

  it('route with capability strategy and tags: warning includes tag metadata', () => {
    const resolver = makeResolver(['svc.a'])
    const ast: FlowNode = {
      type: 'route',
      strategy: 'capability',
      tags: ['vision', 'fast'],
      body: [action('svc.a')],
    }
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.body[0]', toolRef: 'svc.a' },
    ])

    const { warnings } = lowerSkillChain({ ast, resolved, name: 'cap-route' })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('capability')
    expect(warnings[0]).toContain('vision,fast')
  })

  it('complete with a non-empty result: warns that terminal result is dropped', () => {
    // Wrap in a sequence so the chain has at least one real step.
    const resolver = makeResolver(['svc.do'])
    const ast: FlowNode = sequence(
      action('svc.do'),
      { type: 'complete', result: 'ok' },
    )
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.nodes[0]', toolRef: 'svc.do' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'done' })

    // complete emits no step — only svc.do survives.
    expect(artifact.steps).toHaveLength(1)
    expect(artifact.steps[0]).toEqual({ skillName: 'svc.do' })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/complete/i)
    expect(warnings[0]).toContain('ok')
  })

  it('complete with no result: emits no step and no warning', () => {
    const resolver = makeResolver(['svc.do'])
    const ast: FlowNode = sequence(action('svc.do'), { type: 'complete' })
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.nodes[0]', toolRef: 'svc.do' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'done-silent' })

    expect(artifact.steps).toHaveLength(1)
    expect(artifact.steps[0]).toEqual({ skillName: 'svc.do' })
    expect(warnings).toEqual([])
  })

  it('empty result-only top-level chain throws (no action nodes)', () => {
    // A top-level `complete` produces zero steps → invariant violation.
    const ast: FlowNode = { type: 'complete', result: 'done' }
    const resolved = new Map<string, ResolvedTool>()

    expect(() => lowerSkillChain({ ast, resolved, name: 'empty' })).toThrow(
      /no action nodes found/i,
    )
  })

  it('nested sequence: actions at depth-2 are lowered in order', () => {
    const resolver = makeResolver(['step.a', 'step.b', 'step.c', 'step.d'])
    const ast = sequence(
      action('step.a'),
      sequence(action('step.b'), action('step.c')),
      action('step.d'),
    )
    const resolved = buildResolved(resolver, [
      { nodePath: 'root.nodes[0]', toolRef: 'step.a' },
      { nodePath: 'root.nodes[1].nodes[0]', toolRef: 'step.b' },
      { nodePath: 'root.nodes[1].nodes[1]', toolRef: 'step.c' },
      { nodePath: 'root.nodes[2]', toolRef: 'step.d' },
    ])

    const { artifact, warnings } = lowerSkillChain({ ast, resolved, name: 'deep' })

    expect(artifact.steps.map((s) => s.skillName)).toEqual([
      'step.a',
      'step.b',
      'step.c',
      'step.d',
    ])
    // Inner sequence has 2 children — no redundancy warning
    expect(warnings).toEqual([])
  })
})
