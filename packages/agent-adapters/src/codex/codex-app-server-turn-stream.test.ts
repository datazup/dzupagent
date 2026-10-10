import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../types.js'
import type { ActiveRun } from './codex-app-server-adapter-contracts.js'
import type { CodexAppServerInboundEvent } from './codex-app-server-client.js'
import { consumeCodexAppServerTurn } from './codex-app-server-turn-stream.js'

// Admission: COORD-P20-APPSERVER-CHECKPOINT-EVENT-PRESERVATION-20261010-R1.
// Minimized synthetic diagnostic: no real provider payload or host paths.
const workspace = '/synthetic/checkpoint-workspace'
const ids = { threadId: 'synthetic-thread', turnId: 'synthetic-turn' }
const report = JSON.stringify({ schema: 'dzupagent.coordinationAttemptReport/v1',
  attemptId: 'synthetic-attempt', status: 'completed', summary: 'synthetic',
  filesBelievedChanged: [], validationAttempted: [], blockers: [], scopeRequests: [], nextAction: 'none' })
const notification = (method: string, extra: Record<string, unknown> = {}): CodexAppServerInboundEvent =>
  ({ kind: 'notification', method, params: { ...ids, ...extra } })
const message = (id: string, phase?: string) => ({ type: 'agentMessage', id, text: report, phase })
const file = (path: string, kind = 'add') => ({ type: 'fileChange', id: 'synthetic-edit',
  changes: [{ path, kind: { type: kind } }], status: 'completed' })
const terminal = notification('turn/completed', { turn: { id: ids.turnId, items: [], status: 'interrupted' } })

async function replay(frames: CodexAppServerInboundEvent[]) {
  async function* input() { yield* frames }
  const context = { run: ids as ActiveRun, workingDirectory: workspace,
    admittedVersion: '0.147.0', correlationId: 'synthetic-correlation', startedAt: 0,
    now: () => 0, requireRemaining: () => 10000, registerInteraction: () => { throw new Error('unexpected request') } }
  const iterator = consumeCodexAppServerTurn(input(), context)
  const emitted: AgentEvent[] = []
  for (;;) {
    const next = await iterator.next()
    if (next.done) return { emitted, terminal: next.value }
    emitted.push(next.value)
  }
}

describe('app-server normalized checkpoint event preservation', () => {
  it('preserves commentary report then file add before interrupt', async () => {
    const item = message('synthetic-message', 'commentary')
    const edit = file(workspace + '/r0-output.txt')
    const result = await replay([
      notification('item/started', { item }),
      notification('item/agentMessage/delta', { itemId: item.id, delta: report }),
      notification('item/completed', { item }),
      notification('item/started', { item: edit }),
      notification('item/completed', { item: edit }),
      terminal,
    ])
    expect(result.emitted).toEqual([
      { type: 'adapter:stream_delta', providerId: 'codex', content: report, phase: 'commentary', timestamp: 0, correlationId: 'synthetic-correlation' },
      { type: 'adapter:file_change', providerId: 'codex', paths: [{ path: 'r0-output.txt', kind: 'add' }], timestamp: 0, correlationId: 'synthetic-correlation' },
    ])
    expect(result.terminal).toMatchObject({ type: 'adapter:failed', code: 'CODEX_APP_SERVER_CANCELLED' })
  })

  it('takes final_answer phase from the owning message rather than another item', async () => {
    const result = await replay([
      notification('item/started', { item: message('final-message', 'final_answer') }),
      notification('item/started', { item: message('commentary-message', 'commentary') }),
      notification('item/agentMessage/delta', { itemId: 'final-message', delta: 'final' }),
      notification('item/agentMessage/delta', { itemId: 'commentary-message', delta: 'commentary' }),
      terminal,
    ])
    expect(result.emitted).toMatchObject([{ phase: 'final_answer' }, { phase: 'commentary' }])
  })

  it('leaves phase optional when no owning message metadata exists', async () => {
    const result = await replay([notification('item/agentMessage/delta', { itemId: 'legacy', delta: report }), terminal])
    expect(result.emitted).toHaveLength(1)
    expect(result.emitted[0]).not.toHaveProperty('phase')
  })

  it.each(['add', 'update', 'delete'])('normalizes a completed %s only', async kind => {
    const edit = file('nested/../r0-output.txt', kind)
    const result = await replay([notification('item/started', { item: edit }), notification('item/completed', { item: edit }), terminal])
    expect(result.emitted).toMatchObject([{ type: 'adapter:file_change', paths: [{ path: 'r0-output.txt', kind }] }])
  })

  it.each([workspace + '/../outside.txt', '/synthetic/checkpoint-workspace-other/outside.txt', '../outside.txt'])('refuses outside-workspace path %s', async path => {
    await expect(replay([notification('item/completed', { item: file(path) }), terminal]))
      .rejects.toMatchObject({ code: 'CODEX_APP_SERVER_FILE_CHANGE_OUTSIDE_WORKSPACE' })
  })

  it('refuses a mixed batch atomically', async () => {
    const item = { ...file('inside.txt'), changes: [{ path: 'inside.txt', kind: { type: 'add' } }, { path: '../outside.txt', kind: { type: 'delete' } }] }
    await expect(replay([notification('item/completed', { item }), terminal]))
      .rejects.toMatchObject({ code: 'CODEX_APP_SERVER_FILE_CHANGE_OUTSIDE_WORKSPACE' })
  })

  it('refuses a foreign item turn before accepting paths or phase', async () => {
    await expect(replay([notification('item/completed', { turnId: 'foreign-turn', item: file('inside.txt') })]))
      .rejects.toMatchObject({ code: 'CODEX_APP_SERVER_STALE_TURN' })
  })
})
