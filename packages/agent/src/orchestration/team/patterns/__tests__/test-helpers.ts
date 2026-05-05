/**
 * Shared test helpers for `TeamPattern` strategy unit tests.
 *
 * Each pattern test file uses these to build `TeamPatternContext` instances
 * without needing to wire a real `TeamRuntime`.
 */
import { vi } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { KeyedCircuitBreaker } from '@dzupagent/core'
import { DzupAgent } from '../../../../agent/dzip-agent.js'
import {
  SharedWorkspace,
  type TeamSpawnedAgent,
} from '../../team-workspace.js'
import type {
  CoordinatorPattern,
  ParticipantDefinition,
  TeamDefinition,
} from '../../team-definition.js'
import type { TeamPolicies } from '../../team-policy.js'
import type {
  ResolvedParticipant,
  TeamPatternContext,
  TeamPatternHooks,
} from '../team-pattern.js'

export function createMockModel(
  response: string,
  shouldThrow = false,
): BaseChatModel {
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    if (shouldThrow) throw new Error('mock model failed')
    return new AIMessage({ content: response, response_metadata: {} })
  })
  return {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

export function createAgent(
  id: string,
  response = `${id}-result`,
  shouldThrow = false,
): DzupAgent {
  return new DzupAgent({
    id,
    description: `${id} agent`,
    instructions: `You are ${id}.`,
    model: createMockModel(response, shouldThrow),
  })
}

export function buildParticipant(
  id: string,
  role = 'specialist',
  model = 'mock-model',
): ParticipantDefinition {
  return { id, role, model }
}

export function buildResolved(
  id: string,
  options?: { role?: string; response?: string; shouldThrow?: boolean; model?: string },
): ResolvedParticipant {
  const role = options?.role ?? 'specialist'
  const agent = createAgent(id, options?.response ?? `${id}-result`, options?.shouldThrow)
  const participant: ParticipantDefinition = {
    id,
    role,
    model: options?.model ?? 'mock-model',
  }
  const spawned: TeamSpawnedAgent = {
    agent,
    status: 'idle',
    role: role as TeamSpawnedAgent['role'],
    tags: [],
    spawnedAt: Date.now(),
  }
  return { participant, spawned }
}

export interface RecordedHookCalls {
  starts: string[]
  completes: Array<{ id: string; success: boolean; durationMs: number; error?: string }>
  policyApplied: Array<{ group: string; field: string }>
}

export function makeHooksRecorder(): {
  hooks: TeamPatternHooks
  calls: RecordedHookCalls
} {
  const calls: RecordedHookCalls = { starts: [], completes: [], policyApplied: [] }
  const hooks: TeamPatternHooks = {
    emitParticipantStart: (p) => {
      calls.starts.push(p.id)
    },
    emitParticipantComplete: (p, success, durationMs, error) => {
      const entry = error !== undefined
        ? { id: p.id, success, durationMs, error }
        : { id: p.id, success, durationMs }
      calls.completes.push(entry)
    },
    emitPolicyApplied: (group, field) => {
      calls.policyApplied.push({ group, field })
    },
  }
  return { hooks, calls }
}

export function buildContext(
  pattern: CoordinatorPattern,
  participants: ResolvedParticipant[],
  options?: {
    task?: string
    policies?: TeamPolicies
    hooks?: TeamPatternHooks
    teamId?: string
    runId?: string
  },
): { ctx: TeamPatternContext; calls: RecordedHookCalls } {
  const recorder = options?.hooks
    ? { hooks: options.hooks, calls: { starts: [], completes: [], policyApplied: [] } }
    : makeHooksRecorder()
  const teamId = options?.teamId ?? `team-${pattern}`
  const definition: TeamDefinition = {
    id: teamId,
    name: `Team ${pattern}`,
    coordinatorPattern: pattern,
    participants: participants.map((p) => p.participant),
  }
  const ctx: TeamPatternContext = {
    task: options?.task ?? 'mock task',
    teamId,
    runId: options?.runId ?? 'run-1',
    startedAt: Date.now(),
    definition,
    policies: options?.policies ?? {},
    participants,
    workspace: new SharedWorkspace(),
    circuitBreaker: new KeyedCircuitBreaker(),
    otelSpan: undefined,
    hooks: recorder.hooks,
  }
  return { ctx, calls: recorder.calls }
}
