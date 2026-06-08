import type { AdapterProviderId } from '../types.js'

export type DynamicWorkflowProvider = Extract<AdapterProviderId, 'claude' | 'codex'>

export type DynamicWorkflowRole =
  | 'workflow-designer'
  | 'implementation-worker'
  | 'quality-reviewer'
  | 'spec-reviewer'
  | 'summarizer'
  | 'coordinator'

export interface DynamicWorkflowProviderDecision {
  readonly role: DynamicWorkflowRole
  readonly provider: DynamicWorkflowProvider
  readonly fallbackProviders: readonly DynamicWorkflowProvider[]
  readonly reason: string
}

export type DynamicWorkflowRoleRoutes = Readonly<
  Record<DynamicWorkflowRole, DynamicWorkflowProviderDecision>
>

const ROUTES: DynamicWorkflowRoleRoutes = Object.freeze({
  'workflow-designer': freezeDecision({
    role: 'workflow-designer',
    provider: 'claude',
    fallbackProviders: ['codex'],
    reason: 'claude is preferred for workflow design and synthesis',
  }),
  'implementation-worker': freezeDecision({
    role: 'implementation-worker',
    provider: 'codex',
    fallbackProviders: ['claude'],
    reason: 'codex is preferred for repo-local implementation',
  }),
  'quality-reviewer': freezeDecision({
    role: 'quality-reviewer',
    provider: 'codex',
    fallbackProviders: ['claude'],
    reason: 'codex is preferred for code-quality review and verification',
  }),
  'spec-reviewer': freezeDecision({
    role: 'spec-reviewer',
    provider: 'claude',
    fallbackProviders: ['codex'],
    reason: 'claude is preferred for specification review and intent matching',
  }),
  summarizer: freezeDecision({
    role: 'summarizer',
    provider: 'claude',
    fallbackProviders: ['codex'],
    reason: 'claude is preferred for synthesis and summarization',
  }),
  coordinator: freezeDecision({
    role: 'coordinator',
    provider: 'claude',
    fallbackProviders: ['codex'],
    reason: 'claude is preferred for workflow coordination',
  }),
})

function freezeDecision(
  decision: DynamicWorkflowProviderDecision,
): DynamicWorkflowProviderDecision {
  return Object.freeze({
    ...decision,
    fallbackProviders: Object.freeze([...decision.fallbackProviders]),
  })
}

export function resolveDynamicWorkflowProvider(
  role: DynamicWorkflowRole,
): DynamicWorkflowProviderDecision {
  const decision = ROUTES[role]
  if (!decision) {
    throw new Error(`Unknown dynamic workflow role: ${String(role)}`)
  }
  return decision
}

export function getDynamicWorkflowRoleRoutes(): DynamicWorkflowRoleRoutes {
  return ROUTES
}
