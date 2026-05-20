/**
 * Stage 1.5 — compile-time profile expansion.
 *
 * Covers the four core acceptance cases plus negative paths:
 *   1. resolved profile backfills missing node fields
 *   2. node fields override profile fields (precedence)
 *   3. unknown profile → UNRESOLVED_PROFILE_REF
 *   4. profile-supplied toolset is expanded by the same pass
 *   5. profile policy is shallow-merged under node policy
 *   6. registry throw becomes PROFILE_RESOLVER_INFRA_ERROR
 *   7. missing registry warns once (MISSING_PROFILE_REGISTRY) and leaves
 *      the profile ref in place for the runtime safety net
 *   8. resolved profile path strips `node.profile` from the AST (the
 *      compiled artifact must be profile-free)
 */
import type {
  AgentNode,
  FlowNode,
  ResolvedTool,
  SequenceNode,
  ToolResolver,
} from '@dzupagent/flow-ast'
import { describe, expect, it } from 'vitest'

import type { ProfileRegistry, ResolvedProfile } from '../profile-registry.js'
import { createToolsetResolverFromCatalog } from '../host-tool-registry.js'
import { semanticResolve } from '../stages/semantic.js'

const emptyToolResolver = (): ToolResolver => ({
  resolve: (_ref: string): ResolvedTool | null => null,
  listAvailable: () => [],
})

const agentWith = (overrides: Partial<AgentNode>): AgentNode => ({
  type: 'agent',
  agentId: 'planner',
  instructions: 'do the work',
  output: { key: 'plan', schemaRef: 'plan.v1' },
  ...overrides,
})

const sequence = (...nodes: FlowNode[]): SequenceNode => ({ type: 'sequence', nodes })

function makeRegistry(entries: Record<string, ResolvedProfile>): ProfileRegistry {
  return {
    lookup(ref: string): ResolvedProfile | undefined {
      const found = entries[ref]
      return found ? { ...found } : undefined
    },
  }
}

describe('Stage 1.5 — compile-time profile expansion', () => {
  it('resolves profile fields when node fields are absent', async () => {
    // Node carries instructions (parser requires non-empty); model/provider
    // are gaps the profile fills.
    const node = agentWith({ profile: 'research-fast' })
    const ast = sequence(node)
    const profileRegistry = makeRegistry({
      'research-fast': {
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
      },
    })

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      profileRegistry,
    })

    expect(result.errors).toEqual([])
    expect(node.model).toBe('claude-haiku-4-5')
    expect(node.provider).toBe('anthropic')
    // Compiled artifact must be profile-free.
    expect(node.profile).toBeUndefined()

    const path = 'root.nodes[0]'
    const entry = result.expandedAgentProfiles.get(path)
    expect(entry?.ref).toBe('research-fast')
    expect(entry?.resolved.model).toBe('claude-haiku-4-5')
  })

  it('node fields override profile fields (precedence)', async () => {
    const node = agentWith({
      profile: 'research-fast',
      model: 'node-model',
      provider: 'node-provider',
      instructions: 'node instructions',
    })
    const ast = sequence(node)
    const profileRegistry = makeRegistry({
      'research-fast': {
        model: 'profile-model',
        provider: 'profile-provider',
        instructions: 'profile instructions',
      },
    })

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      profileRegistry,
    })

    expect(result.errors).toEqual([])
    expect(node.model).toBe('node-model')
    expect(node.provider).toBe('node-provider')
    expect(node.instructions).toBe('node instructions')
    expect(node.profile).toBeUndefined()
  })

  it('emits UNRESOLVED_PROFILE_REF for an unknown profile name', async () => {
    const node = agentWith({ profile: 'does-not-exist' })
    const ast = sequence(node)
    const profileRegistry = makeRegistry({})

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      profileRegistry,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('UNRESOLVED_PROFILE_REF')
    expect(result.errors[0]?.message).toContain('"does-not-exist"')
    expect(result.errors[0]?.nodePath).toBe('root.nodes[0]')
    // Profile ref left intact on failure so operators can see the bad ref
    // in subsequent diagnostics; runtime would still see it but the
    // compile is already failing.
    expect(node.profile).toBe('does-not-exist')
  })

  it('flattens a profile-supplied toolset by handing it to the toolset resolver', async () => {
    const node = agentWith({ profile: 'planning-profile' })
    const ast = sequence(node)
    const profileRegistry = makeRegistry({
      'planning-profile': {
        model: 'claude-haiku-4-5',
        toolset: 'planning',
      },
    })
    const toolsetResolver = createToolsetResolverFromCatalog([
      { name: 'planning', tools: ['pm.create_task', 'pm.update_task'] },
    ])

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      toolsetResolver,
      profileRegistry,
    })

    expect(result.errors).toEqual([])
    expect(node.model).toBe('claude-haiku-4-5')
    // toolset was applied from the profile, then expanded into tools[].
    expect(node.tools).toEqual(['pm.create_task', 'pm.update_task'])
    // Both compile-time refs are stripped from the AST after expansion.
    expect(node.profile).toBeUndefined()
  })

  it('shallow-merges profile policy under node policy', async () => {
    const node = agentWith({
      profile: 'budget-strict',
      policy: {
        timeoutMs: 5_000,
        audit: { captureDiffs: true },
      },
    })
    const ast = sequence(node)
    const profileRegistry = makeRegistry({
      'budget-strict': {
        policy: {
          timeoutMs: 60_000, // overridden by node
          budgetCents: 10, // wins (node has no budgetCents)
          audit: { captureToolCalls: true },
        },
      },
    })

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      profileRegistry,
    })

    expect(result.errors).toEqual([])
    expect(node.policy?.timeoutMs).toBe(5_000) // node wins
    expect(node.policy?.budgetCents).toBe(10) // profile fills the gap
    expect(node.policy?.audit?.captureDiffs).toBe(true) // node
    expect(node.policy?.audit?.captureToolCalls).toBe(true) // profile
  })

  it('turns a registry throw into PROFILE_RESOLVER_INFRA_ERROR', async () => {
    const node = agentWith({ profile: 'planning' })
    const ast = sequence(node)
    const profileRegistry: ProfileRegistry = {
      lookup: () => {
        throw new Error('registry offline')
      },
    }

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      profileRegistry,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('PROFILE_RESOLVER_INFRA_ERROR')
    expect(result.errors[0]?.message).toContain('registry offline')
  })

  it('warns once and leaves the profile ref intact when no registry is supplied', async () => {
    const a = agentWith({ profile: 'p1' })
    const b = agentWith({ agentId: 'reviewer', profile: 'p2' })
    const ast = sequence(a, b)

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
    })

    expect(result.errors).toEqual([])
    const warnings = result.warnings.filter((w) => w.code === 'MISSING_PROFILE_REGISTRY')
    expect(warnings).toHaveLength(1)
    // Profile refs preserved — runtime backfill path remains the safety net.
    expect(a.profile).toBe('p1')
    expect(b.profile).toBe('p2')
  })

  it('is a no-op when the node has no profile field', async () => {
    const node = agentWith({ model: 'explicit-model' })
    const ast = sequence(node)
    const profileRegistry = makeRegistry({
      'unused': { model: 'wrong' },
    })

    const result = await semanticResolve(ast, {
      toolResolver: emptyToolResolver(),
      profileRegistry,
    })

    expect(result.errors).toEqual([])
    expect(node.model).toBe('explicit-model')
    expect(result.expandedAgentProfiles.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// End-to-end via createFlowCompiler
// ---------------------------------------------------------------------------

import { createFlowCompiler } from '../index.js'

describe('createFlowCompiler — profile flattening end-to-end', () => {
  it('passes a profileRegistry through to semantic resolution and emits a profile-free artifact', async () => {
    const profileRegistry = makeRegistry({
      'research-fast': {
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        instructions: 'fast researcher',
      },
    })

    const compiler = createFlowCompiler({
      toolResolver: emptyToolResolver(),
      profileRegistry,
    })

    // Wrap the agent in a for_each so route-target lands on `pipeline`
    // (lowerSkillChain rejects agent-only flows). The profile-flatten
    // behavior under test is independent of the chosen lowering target.
    const inputDoc = {
      type: 'sequence' as const,
      nodes: [
        {
          type: 'for_each' as const,
          source: 'state.items',
          as: 'i',
          body: [
            {
              type: 'agent' as const,
              agentId: 'planner',
              profile: 'research-fast',
              instructions: 'do the work',
              output: { key: 'plan', schemaRef: 'plan.v1' },
            },
          ],
        },
      ],
    }

    // CompileSuccess has `artifact`; CompileFailure has `errors`. Narrowing
    // on `errors in result` makes the flattening landing point explicit.
    const result = await compiler.compile(inputDoc)
    if ('errors' in result) {
      throw new Error(
        `expected CompileSuccess; got errors: ${JSON.stringify(result.errors)}`,
      )
    }

    // The compile pipeline executed through routing + lowering without
    // surfacing the profile reference anywhere on the emitted artifact
    // (current lowerers don't serialise agent.model, but the contract
    // here is profile-free emission — the ref must not survive).
    const artifactJson = JSON.stringify(result.artifact)
    expect(artifactJson).not.toContain('research-fast')
    expect(artifactJson).not.toContain('"profile"')
  })
})
