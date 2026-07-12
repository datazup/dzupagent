import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimePlan } from '@dzupagent/adapter-rules'

import {
  ADAPTER_RULE_AUDIT_FLAGS_OPTION,
  ADAPTER_RULE_DENIED_PATHS_OPTION,
  ADAPTER_RULE_PROVIDER_CONFIG_PATCH_OPTION,
  ADAPTER_RULE_RUNTIME_PLAN_OPTION,
  getAdapterRuleRuntimePlan,
  prepareAdapterRuleRuntime,
  projectAdapterRuleRuntimePlan,
  resolveRuntimePlanWatcherPaths,
  withAdapterRuleRuntimePlan,
} from '../rules.js'

function makePlan(overrides: Partial<RuntimePlan> = {}): RuntimePlan {
  return {
    providerId: 'codex',
    promptSections: [],
    requiredSkills: [],
    preferredAgent: undefined,
    providerConfigPatch: {},
    monitorSubscriptions: [],
    watchPaths: [],
    auditFlags: [],
    deniedPaths: [],
    alerts: [],
    watcherRegistrations: [],
    ...overrides,
  }
}

describe('rule-aware adapter runtime helpers', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-adapters-rules-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('attaches a runtime plan and appends prompt sections to systemPrompt', () => {
    const plan = makePlan({
      promptSections: ['Use repo evidence.', 'Return JSON.'],
    })

    const input = withAdapterRuleRuntimePlan(
      { prompt: 'review', systemPrompt: 'Base instructions.' },
      plan,
    )

    expect(input.systemPrompt).toBe('Base instructions.\n\nUse repo evidence.\n\nReturn JSON.')
    expect(input.options?.[ADAPTER_RULE_RUNTIME_PLAN_OPTION]).toBe(plan)
    expect(getAdapterRuleRuntimePlan(input, 'codex')).toBe(plan)
    expect(getAdapterRuleRuntimePlan(input, 'claude')).toBeUndefined()
  })

  it('resolves watcher registrations and watch_path effects against the working directory', () => {
    const plan = makePlan({
      watchPaths: ['artifacts/reviews'],
      watcherRegistrations: [
        {
          path: '.codex/',
          provider: 'codex',
          watchClass: 'project',
        },
        {
          path: '.codex',
          provider: 'codex',
          watchClass: 'project',
        },
      ],
    })

    expect(resolveRuntimePlanWatcherPaths(plan, '/workspace')).toEqual([
      '/workspace/.codex',
      '/workspace/artifacts/reviews',
    ])
  })

  it('projects codex approval config and rule metadata into adapter input options', () => {
    const plan = makePlan({
      providerConfigPatch: { approvalPolicy: 'on-failure' },
      auditFlags: ['approval:bash'],
      deniedPaths: ['.env'],
    })

    const projection = projectAdapterRuleRuntimePlan({ prompt: 'ship it' }, plan)

    expect(projection.input.options?.['approvalPolicy']).toBe('on-failure')
    expect(projection.input.options?.[ADAPTER_RULE_PROVIDER_CONFIG_PATCH_OPTION]).toEqual({
      approvalPolicy: 'on-failure',
    })
    expect(projection.input.options?.[ADAPTER_RULE_AUDIT_FLAGS_OPTION]).toEqual([
      'approval:bash',
    ])
    expect(projection.input.options?.[ADAPTER_RULE_DENIED_PATHS_OPTION]).toEqual(['.env'])
    expect(projection.guardrails).toEqual({
      auditFlags: ['approval:bash'],
      deniedPaths: ['.env'],
      requiredSkills: [],
      preferredAgent: undefined,
    })
  })

  it('does not overwrite explicit per-call provider input options', () => {
    const plan = makePlan({
      providerConfigPatch: { approvalPolicy: 'on-failure' },
    })

    const input = withAdapterRuleRuntimePlan(
      { prompt: 'ship it', options: { approvalPolicy: 'never' } },
      plan,
    )

    expect(input.options?.['approvalPolicy']).toBe('never')
  })

  it('projects claude provider config patch into adapter providerOptions', () => {
    const plan = makePlan({
      providerId: 'claude',
      providerConfigPatch: {
        permissions: {
          additionalPermissions: ['approval:tool'],
        },
      },
    })

    const projection = projectAdapterRuleRuntimePlan({ prompt: 'review' }, plan, {
      config: { providerOptions: { modelSettings: { temperature: 0 } } },
    })

    expect(projection.config.providerOptions).toEqual({
      modelSettings: { temperature: 0 },
      [ADAPTER_RULE_PROVIDER_CONFIG_PATCH_OPTION]: {
        permissions: {
          additionalPermissions: ['approval:tool'],
        },
      },
      permissions: {
        additionalPermissions: ['approval:tool'],
      },
    })
  })

  it('projects the proven Goose approval config into gooseMode when absent', () => {
    const plan = makePlan({
      providerId: 'goose',
      providerConfigPatch: { GOOSE_MODE: 'approve' },
    })

    const projection = projectAdapterRuleRuntimePlan({ prompt: 'review' }, plan)

    expect(projection.input.options?.['gooseMode']).toBe('approve')
    expect(projection.input.options?.['permissionMode']).toBeUndefined()
  })

  it('loads rules, compiles a runtime plan, and emits governance for load diagnostics', async () => {
    await writeFile(
      join(tempDir, 'valid.json'),
      JSON.stringify({
        id: 'repo-evidence',
        name: 'Require repo evidence',
        scope: 'project',
        appliesToProviders: ['codex'],
        effects: [{ kind: 'prompt_section', purpose: 'task', content: 'Use repo evidence.' }],
      }),
      'utf8',
    )
    await writeFile(
      join(tempDir, 'invalid.json'),
      JSON.stringify({
        id: 'bad',
        name: 'Bad',
        scope: 'project',
        appliesToProviders: ['codex'],
        effects: [{ kind: 'deny_path' }],
      }),
      'utf8',
    )
    const governanceEvents: unknown[] = []

    const prepared = await prepareAdapterRuleRuntime(
      { prompt: 'review', correlationId: 'run-1' },
      { providerId: 'codex', workspaceDir: tempDir },
      {
        ruleDirectory: tempDir,
        timestamp: 123,
        emitGovernanceEvent: (event) => governanceEvents.push(event),
      },
    )

    expect(prepared.rules.map((rule) => rule.id)).toEqual(['repo-evidence'])
    expect(prepared.plan.promptSections).toEqual(['Use repo evidence.'])
    expect(prepared.input.systemPrompt).toBe('Use repo evidence.')
    expect(prepared.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid_rule',
        ruleId: 'adapter_rule_load_error',
        severity: 'warn',
        errors: ['effects[0].path must be a non-empty string'],
      }),
    ])
    expect(governanceEvents).toEqual([
      expect.objectContaining({
        type: 'governance:rule_violation',
        runId: 'run-1',
        providerId: 'codex',
        timestamp: 123,
        ruleId: 'adapter_rule_load_error',
        severity: 'warn',
      }),
    ])
  })

  it('converts compiler failures into blocking governance diagnostics and an empty plan', async () => {
    const governanceEvents: unknown[] = []

    const prepared = await prepareAdapterRuleRuntime(
      { prompt: 'review', correlationId: 'run-2', systemPrompt: 'base' },
      { providerId: 'codex' },
      {
        rules: [
          {
            id: 'repo-evidence',
            name: 'Require repo evidence',
            scope: 'project',
            appliesToProviders: ['codex'],
            effects: [{ kind: 'prompt_section', purpose: 'task', content: 'Use repo evidence.' }],
          },
        ],
        compiler: {
          compile: () => {
            throw new Error('compiler unavailable')
          },
        },
        emitGovernanceEvent: (event) => governanceEvents.push(event),
        timestamp: 456,
      },
    )

    expect(prepared.plan.promptSections).toEqual([])
    expect(prepared.input.systemPrompt).toBe('base')
    expect(prepared.diagnostics).toEqual([
      {
        code: 'compile_error',
        ruleId: 'rule_compile_error',
        severity: 'block',
        detail: 'Rule compiler failed: compiler unavailable',
      },
    ])
    expect(governanceEvents).toEqual([
      expect.objectContaining({
        type: 'governance:rule_violation',
        runId: 'run-2',
        providerId: 'codex',
        timestamp: 456,
        ruleId: 'rule_compile_error',
        severity: 'block',
        detail: 'Rule compiler failed: compiler unavailable',
      }),
    ])
  })
})
