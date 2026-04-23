/**
 * TeamRuntime load bench.
 *
 * Measures throughput / latency when 50 TeamRuntime instances execute
 * concurrently, each with a minimal stubbed LLM. Focus is on orchestration
 * overhead — span bookkeeping, phase transitions, participant resolution,
 * and Promise.allSettled fan-out — not on real model latency.
 *
 * Run with:
 *   yarn workspace @dzupagent/agent vitest bench src/orchestration/team/__benches__
 *
 * The built-in vitest bench timing is supplemented by a manual p95 latency
 * assertion at the end of the run so the bench fails fast when orchestration
 * overhead regresses past the 200ms target.
 */
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { bench, describe, expect } from 'vitest'
import { DzupAgent } from '../../../agent/dzip-agent.js'
import { TeamRuntime } from '../team-runtime.js'
import type { ParticipantDefinition, TeamDefinition } from '../team-definition.js'
import type { SpawnedAgent } from '../../../playground/types.js'

// ---------------------------------------------------------------------------
// Minimal, allocation-cheap stubs
// ---------------------------------------------------------------------------

function createStubModel(): BaseChatModel {
  return {
    invoke: async (_m: BaseMessage[]) =>
      new AIMessage({ content: 'stub', response_metadata: {} }),
    bindTools(this: BaseChatModel) {
      return this
    },
    _modelType: () => 'base_chat_model',
    _llmType: () => 'stub',
  } as unknown as BaseChatModel
}

function stubAgent(id: string): DzupAgent {
  return new DzupAgent({
    id,
    description: 'bench',
    instructions: 'bench',
    model: createStubModel(),
  })
}

function stubDefinition(id: string): TeamDefinition {
  return {
    id,
    name: id,
    coordinatorPattern: 'peer_to_peer',
    participants: [
      { id: `${id}-p1`, role: 'supervisor', model: 'stub' },
      { id: `${id}-p2`, role: 'specialist', model: 'stub' },
      { id: `${id}-p3`, role: 'specialist', model: 'stub' },
    ] as ParticipantDefinition[],
  }
}

async function stubResolver(p: ParticipantDefinition): Promise<SpawnedAgent> {
  return {
    agent: stubAgent(p.id),
    status: 'idle',
    role: p.role as SpawnedAgent['role'],
    tags: [],
    spawnedAt: Date.now(),
  }
}

async function runOne(idx: number): Promise<number> {
  const runtime = new TeamRuntime({
    definition: stubDefinition(`bench-team-${idx}`),
    resolveParticipant: stubResolver,
  })
  const t0 = performance.now()
  await runtime.execute('bench-task')
  return performance.now() - t0
}

// ---------------------------------------------------------------------------
// Bench suite
// ---------------------------------------------------------------------------

describe('TeamRuntime load bench', () => {
  bench(
    '50 concurrent TeamRuntime instances',
    async () => {
      const promises = Array.from({ length: 50 }, (_, i) => runOne(i))
      await Promise.all(promises)
    },
    { iterations: 20, warmupIterations: 3 },
  )

  // Manual p95 check — vitest bench collects its own stats, but we also
  // need a hard latency budget that fails the run when orchestration cost
  // regresses. We run 50 concurrent instances, record per-run latency, and
  // assert p95 < 200ms.
  bench(
    'p95 latency < 200ms (50 concurrent)',
    async () => {
      const latencies = await Promise.all(
        Array.from({ length: 50 }, (_, i) => runOne(i)),
      )
      latencies.sort((a, b) => a - b)
      const p95Index = Math.floor(latencies.length * 0.95)
      const p95 = latencies[p95Index] ?? latencies[latencies.length - 1]!
      expect(p95).toBeLessThan(200)
    },
    { iterations: 10, warmupIterations: 2 },
  )
})
