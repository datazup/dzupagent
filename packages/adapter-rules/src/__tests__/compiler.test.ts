import { describe, it, expect } from 'vitest'

import { RuleCompiler } from '../compiler.js'
import type { AdapterRule, CompileContext } from '../types.js'

function rule(partial: Partial<AdapterRule> & { id: string; effects: AdapterRule['effects'] }): AdapterRule {
  return {
    name: partial.name ?? partial.id,
    scope: partial.scope ?? 'project',
    appliesToProviders: partial.appliesToProviders ?? ['*'],
    match: partial.match,
    ...partial,
  }
}

const claudeCtx: CompileContext = { providerId: 'claude' }
const codexCtx: CompileContext = { providerId: 'codex' }
const geminiCtx: CompileContext = { providerId: 'gemini' }
const qwenCtx: CompileContext = { providerId: 'qwen' }
const gooseCtx: CompileContext = { providerId: 'goose' }
const crushCtx: CompileContext = { providerId: 'crush' }

describe('RuleCompiler', () => {
  it('returns an empty RuntimePlan for empty rules', () => {
    const plan = new RuleCompiler().compile([], claudeCtx)
    expect(plan).toEqual({
      providerId: 'claude',
      promptSections: [],
      requiredSkills: [],
      preferredAgent: undefined,
      providerConfigPatch: {},
      monitorSubscriptions: [],
      watchPaths: [],
      auditFlags: [],
      deniedPaths: [],
      alerts: [],
    })
  })

  it('projects prompt_section effects into promptSections', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          effects: [{ kind: 'prompt_section', purpose: 'persona', content: 'Be careful.' }],
        }),
      ],
      claudeCtx,
    )
    expect(plan.promptSections).toEqual(['Be careful.'])
  })

  it('projects watch_path effects into watchPaths and monitorSubscriptions', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          effects: [{ kind: 'watch_path', path: '.claude/agents', artifactKind: 'agent_definition' }],
        }),
      ],
      claudeCtx,
    )
    expect(plan.watchPaths).toEqual(['.claude/agents'])
    expect(plan.monitorSubscriptions).toEqual(['artifact:agent_definition'])
  })

  it('projects require_approval effects into auditFlags as approval:<target>', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          effects: [
            { kind: 'require_approval', target: 'bash' },
            { kind: 'require_approval', target: 'network' },
          ],
        }),
      ],
      claudeCtx,
    )
    expect(plan.auditFlags).toEqual(['approval:bash', 'approval:network'])
  })

  it('skips rules whose appliesToProviders does not include the current provider', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          appliesToProviders: ['claude'],
          effects: [{ kind: 'prompt_section', purpose: 'persona', content: 'Claude only' }],
        }),
      ],
      codexCtx,
    )
    expect(plan.promptSections).toEqual([])
  })

  it('applies rules with appliesToProviders: ["*"] to all providers', () => {
    const rules: AdapterRule[] = [
      rule({
        id: 'r1',
        appliesToProviders: ['*'],
        effects: [{ kind: 'prompt_section', purpose: 'style', content: 'Universal' }],
      }),
    ]
    const claudePlan = new RuleCompiler().compile(rules, claudeCtx)
    const codexPlan = new RuleCompiler().compile(rules, codexCtx)
    expect(claudePlan.promptSections).toEqual(['Universal'])
    expect(codexPlan.promptSections).toEqual(['Universal'])
  })

  it('skips rule when match.paths is set and context.pathScope does not match any path', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          match: { paths: ['apps/api'] },
          effects: [{ kind: 'prompt_section', purpose: 'task', content: 'API rule' }],
        }),
      ],
      { ...claudeCtx, pathScope: 'apps/web/src/page.tsx' },
    )
    expect(plan.promptSections).toEqual([])
  })

  it('applies rule when context.pathScope startsWith one of match.paths entries', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          match: { paths: ['apps/api'] },
          effects: [{ kind: 'prompt_section', purpose: 'task', content: 'API rule' }],
        }),
      ],
      { ...claudeCtx, pathScope: 'apps/api/src/server.ts' },
    )
    expect(plan.promptSections).toEqual(['API rule'])
  })

  it('skips rule when match.requestTags set and no tags overlap with context.requestTags', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          match: { requestTags: ['refactor'] },
          effects: [{ kind: 'prompt_section', purpose: 'task', content: 'R' }],
        }),
      ],
      { ...claudeCtx, requestTags: ['explain'] },
    )
    expect(plan.promptSections).toEqual([])
  })

  it('applies rule when at least one of match.requestTags is present in context', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          match: { requestTags: ['refactor', 'explain'] },
          effects: [{ kind: 'prompt_section', purpose: 'task', content: 'R' }],
        }),
      ],
      { ...claudeCtx, requestTags: ['explain'] },
    )
    expect(plan.promptSections).toEqual(['R'])
  })

  it('skips rule when match.models set and context.model does not match', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          match: { models: ['claude-opus-4-7'] },
          effects: [{ kind: 'prompt_section', purpose: 'task', content: 'Opus only' }],
        }),
      ],
      { ...claudeCtx, model: 'claude-sonnet-4-6' },
    )
    expect(plan.promptSections).toEqual([])
  })

  it('Claude provider config patch includes approval permissions when require_approval present', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          effects: [{ kind: 'require_approval', target: 'bash' }],
        }),
      ],
      claudeCtx,
    )
    expect(plan.providerConfigPatch).toEqual({
      permissions: { additionalPermissions: ['approval:bash'] },
    })
  })

  it('Codex provider config patch includes approvalPolicy: "on-failure" when require_approval present', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          effects: [{ kind: 'require_approval', target: 'network' }],
        }),
      ],
      codexCtx,
    )
    expect(plan.providerConfigPatch).toEqual({ approvalPolicy: 'on-failure' })
  })

  it('returns an empty providerConfigPatch when no approval effects are present', () => {
    const plan = new RuleCompiler().compile(
      [rule({ id: 'r1', effects: [{ kind: 'prompt_section', purpose: 'style', content: 'x' }] })],
      claudeCtx,
    )
    expect(plan.providerConfigPatch).toEqual({})
  })

  it('accumulates prompt sections from multiple rules in order', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({ id: 'a', effects: [{ kind: 'prompt_section', purpose: 'persona', content: 'A' }] }),
        rule({ id: 'b', effects: [{ kind: 'prompt_section', purpose: 'style', content: 'B' }] }),
        rule({ id: 'c', effects: [{ kind: 'prompt_section', purpose: 'safety', content: 'C' }] }),
      ],
      claudeCtx,
    )
    expect(plan.promptSections).toEqual(['A', 'B', 'C'])
  })

  it('projects deny_path effects into deniedPaths', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          effects: [
            { kind: 'deny_path', path: '.env' },
            { kind: 'deny_path', path: 'secrets/' },
          ],
        }),
      ],
      claudeCtx,
    )
    expect(plan.deniedPaths).toEqual(['.env', 'secrets/'])
  })

  it('projects require_skill, prefer_agent, and emit_alert correctly', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          effects: [
            { kind: 'require_skill', skill: 'run-tests' },
            { kind: 'prefer_agent', agent: 'reviewer' },
            { kind: 'prefer_agent', agent: 'reviewer-v2' },
            { kind: 'emit_alert', on: 'bash_loop', severity: 'warning' },
          ],
        }),
      ],
      claudeCtx,
    )
    expect(plan.requiredSkills).toEqual(['run-tests'])
    // last-writer-wins
    expect(plan.preferredAgent).toBe('reviewer-v2')
    expect(plan.alerts).toEqual([{ on: 'bash_loop', severity: 'warning' }])
  })

  it('treats match.paths as a filter gate when context.pathScope is undefined', () => {
    // When match.paths is declared but no pathScope is available, the rule
    // cannot possibly be scoped correctly and should be skipped.
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          match: { paths: ['apps/api'] },
          effects: [{ kind: 'prompt_section', purpose: 'task', content: 'X' }],
        }),
      ],
      claudeCtx,
    )
    expect(plan.promptSections).toEqual([])
  })

  it('Gemini provider config patch sets trust_tools: false when require_approval present', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          effects: [{ kind: 'require_approval', target: 'bash' }],
        }),
      ],
      geminiCtx,
    )
    expect(plan.providerConfigPatch).toEqual({
      trust_tools: false,
      tool_config: {
        require_confirmation: true,
        approvals: ['approval:bash'],
      },
    })
  })

  it('Gemini provider config patch is empty when no approval effects are present', () => {
    const plan = new RuleCompiler().compile(
      [rule({ id: 'r1', effects: [{ kind: 'prompt_section', purpose: 'style', content: 'x' }] })],
      geminiCtx,
    )
    expect(plan.providerConfigPatch).toEqual({})
  })

  it('Qwen provider config patch sets approval_mode: "require" when require_approval present', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          effects: [{ kind: 'require_approval', target: 'network' }],
        }),
      ],
      qwenCtx,
    )
    expect(plan.providerConfigPatch).toEqual({ approval_mode: 'require' })
  })

  it('Qwen provider config patch is empty when no approval effects are present', () => {
    const plan = new RuleCompiler().compile(
      [rule({ id: 'r1', effects: [{ kind: 'prompt_section', purpose: 'style', content: 'x' }] })],
      qwenCtx,
    )
    expect(plan.providerConfigPatch).toEqual({})
  })

  it('Goose provider config patch sets goose.mode: approve when require_approval present', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          effects: [{ kind: 'require_approval', target: 'bash' }],
        }),
      ],
      gooseCtx,
    )
    expect(plan.providerConfigPatch).toEqual({ goose: { mode: 'approve' } })
  })

  it('Goose provider config patch is empty when no approval effects are present', () => {
    const plan = new RuleCompiler().compile(
      [rule({ id: 'r1', effects: [{ kind: 'prompt_section', purpose: 'style', content: 'x' }] })],
      gooseCtx,
    )
    expect(plan.providerConfigPatch).toEqual({})
  })

  it('Crush provider config patch sets permissionMode: ask when require_approval present', () => {
    const plan = new RuleCompiler().compile(
      [
        rule({
          id: 'r1',
          effects: [{ kind: 'require_approval', target: 'network' }],
        }),
      ],
      crushCtx,
    )
    expect(plan.providerConfigPatch).toEqual({ permissionMode: 'ask' })
  })

  it('Crush provider config patch is empty when no approval effects are present', () => {
    const plan = new RuleCompiler().compile(
      [rule({ id: 'r1', effects: [{ kind: 'prompt_section', purpose: 'style', content: 'x' }] })],
      crushCtx,
    )
    expect(plan.providerConfigPatch).toEqual({})
  })
})
