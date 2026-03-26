import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryA2ATaskStore } from '../task-handler.js'
import type { A2ATask, A2ATaskMessage } from '../task-handler.js'

describe('InMemoryA2ATaskStore', () => {
  let store: InMemoryA2ATaskStore

  beforeEach(() => {
    store = new InMemoryA2ATaskStore()
  })

  // -----------------------------------------------------------------------
  // Basic CRUD (existing behavior)
  // -----------------------------------------------------------------------

  describe('create', () => {
    it('creates a task with empty messages and artifacts', async () => {
      const task = await store.create({
        agentName: 'test-agent',
        input: 'hello',
        state: 'submitted',
      })

      expect(task.id).toBe('a2a-task-1')
      expect(task.state).toBe('submitted')
      expect(task.agentName).toBe('test-agent')
      expect(task.messages).toEqual([])
      expect(task.artifacts).toEqual([])
      expect(task.pushNotificationConfig).toBeUndefined()
    })
  })

  describe('get', () => {
    it('returns null for nonexistent task', async () => {
      expect(await store.get('nonexistent')).toBeNull()
    })

    it('returns existing task', async () => {
      const created = await store.create({
        agentName: 'test-agent',
        input: 'hello',
        state: 'submitted',
      })
      const retrieved = await store.get(created.id)
      expect(retrieved).toEqual(created)
    })
  })

  describe('update', () => {
    it('updates task state', async () => {
      const task = await store.create({
        agentName: 'test-agent',
        input: 'hello',
        state: 'submitted',
      })
      const updated = await store.update(task.id, { state: 'working' })
      expect(updated?.state).toBe('working')
    })

    it('returns null for nonexistent task', async () => {
      expect(await store.update('nonexistent', { state: 'working' })).toBeNull()
    })
  })

  describe('list', () => {
    it('lists all tasks', async () => {
      await store.create({ agentName: 'a', input: '1', state: 'submitted' })
      await store.create({ agentName: 'b', input: '2', state: 'working' })

      const tasks = await store.list()
      expect(tasks).toHaveLength(2)
    })

    it('filters by agentName', async () => {
      await store.create({ agentName: 'a', input: '1', state: 'submitted' })
      await store.create({ agentName: 'b', input: '2', state: 'submitted' })

      const tasks = await store.list({ agentName: 'a' })
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.agentName).toBe('a')
    })

    it('filters by state', async () => {
      await store.create({ agentName: 'a', input: '1', state: 'submitted' })
      await store.create({ agentName: 'a', input: '2', state: 'working' })

      const tasks = await store.list({ state: 'working' })
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.state).toBe('working')
    })
  })

  // -----------------------------------------------------------------------
  // Multi-turn: appendMessage
  // -----------------------------------------------------------------------

  describe('appendMessage', () => {
    it('appends a user message to a task', async () => {
      const task = await store.create({
        agentName: 'test-agent',
        input: 'hello',
        state: 'input-required',
      })

      const msg: A2ATaskMessage = {
        role: 'user',
        parts: [{ type: 'text', text: 'Here is more context' }],
      }

      const updated = await store.appendMessage(task.id, msg)
      expect(updated).not.toBeNull()
      expect(updated?.messages).toHaveLength(1)
      expect(updated?.messages[0]?.role).toBe('user')
      expect(updated?.messages[0]?.parts[0]?.text).toBe('Here is more context')
    })

    it('appends multiple messages in order', async () => {
      const task = await store.create({
        agentName: 'test-agent',
        input: 'hello',
        state: 'working',
      })

      await store.appendMessage(task.id, {
        role: 'user',
        parts: [{ type: 'text', text: 'msg1' }],
      })
      await store.appendMessage(task.id, {
        role: 'agent',
        parts: [{ type: 'text', text: 'msg2' }],
      })
      await store.appendMessage(task.id, {
        role: 'user',
        parts: [{ type: 'text', text: 'msg3' }],
      })

      const updated = await store.get(task.id)
      expect(updated?.messages).toHaveLength(3)
      expect(updated?.messages.map((m) => m.role)).toEqual(['user', 'agent', 'user'])
    })

    it('returns null for nonexistent task', async () => {
      const result = await store.appendMessage('nonexistent', {
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      })
      expect(result).toBeNull()
    })

    it('updates the updatedAt timestamp', async () => {
      const task = await store.create({
        agentName: 'test-agent',
        input: 'hello',
        state: 'working',
      })

      const originalUpdatedAt = task.updatedAt

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 5))

      const updated = await store.appendMessage(task.id, {
        role: 'user',
        parts: [{ type: 'text', text: 'more input' }],
      })

      expect(updated?.updatedAt).not.toBe(originalUpdatedAt)
    })
  })

  // -----------------------------------------------------------------------
  // Artifacts: addArtifact
  // -----------------------------------------------------------------------

  describe('addArtifact', () => {
    it('adds an artifact with auto-incrementing index', async () => {
      const task = await store.create({
        agentName: 'test-agent',
        input: 'hello',
        state: 'working',
      })

      const updated = await store.addArtifact(task.id, {
        parts: [{ type: 'text', text: 'generated code' }],
        name: 'main.ts',
      })

      expect(updated?.artifacts).toHaveLength(1)
      expect(updated?.artifacts[0]?.index).toBe(0)
      expect(updated?.artifacts[0]?.name).toBe('main.ts')
    })

    it('adds multiple artifacts with incrementing indices', async () => {
      const task = await store.create({
        agentName: 'test-agent',
        input: 'hello',
        state: 'working',
      })

      await store.addArtifact(task.id, {
        parts: [{ type: 'text', text: 'file1' }],
        name: 'a.ts',
      })
      await store.addArtifact(task.id, {
        parts: [{ type: 'text', text: 'file2' }],
        name: 'b.ts',
      })

      const updated = await store.get(task.id)
      expect(updated?.artifacts).toHaveLength(2)
      expect(updated?.artifacts[0]?.index).toBe(0)
      expect(updated?.artifacts[1]?.index).toBe(1)
    })

    it('returns null for nonexistent task', async () => {
      const result = await store.addArtifact('nonexistent', {
        parts: [{ type: 'text', text: 'code' }],
      })
      expect(result).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Push notifications: setPushConfig
  // -----------------------------------------------------------------------

  describe('setPushConfig', () => {
    it('sets push notification config', async () => {
      const task = await store.create({
        agentName: 'test-agent',
        input: 'hello',
        state: 'submitted',
      })

      const updated = await store.setPushConfig(task.id, {
        url: 'https://example.com/webhook',
        token: 'secret',
        events: ['task.completed'],
      })

      expect(updated?.pushNotificationConfig).toEqual({
        url: 'https://example.com/webhook',
        token: 'secret',
        events: ['task.completed'],
      })
    })

    it('returns null for nonexistent task', async () => {
      const result = await store.setPushConfig('nonexistent', {
        url: 'https://example.com/webhook',
      })
      expect(result).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Multi-turn flow
  // -----------------------------------------------------------------------

  describe('multi-turn flow', () => {
    it('simulates create -> input-required -> send more input -> completed', async () => {
      // 1. Create task
      const task = await store.create({
        agentName: 'code-agent',
        input: 'Build a REST API',
        state: 'submitted',
      })

      // 2. Agent processes, needs more input
      await store.appendMessage(task.id, {
        role: 'user',
        parts: [{ type: 'text', text: 'Build a REST API' }],
      })
      await store.appendMessage(task.id, {
        role: 'agent',
        parts: [{ type: 'text', text: 'What framework should I use?' }],
      })
      await store.update(task.id, { state: 'input-required' })

      // 3. User provides more input
      await store.appendMessage(task.id, {
        role: 'user',
        parts: [{ type: 'text', text: 'Use Express' }],
      })
      await store.update(task.id, { state: 'working' })

      // 4. Agent completes the task
      await store.appendMessage(task.id, {
        role: 'agent',
        parts: [{ type: 'text', text: 'Here is your Express API' }],
      })
      await store.addArtifact(task.id, {
        parts: [{ type: 'text', text: 'const express = require("express")' }],
        name: 'index.js',
      })
      await store.update(task.id, { state: 'completed' })

      // 5. Verify final state
      const final = await store.get(task.id) as A2ATask
      expect(final.state).toBe('completed')
      expect(final.messages).toHaveLength(4)
      expect(final.artifacts).toHaveLength(1)
      expect(final.messages[0]?.role).toBe('user')
      expect(final.messages[1]?.role).toBe('agent')
      expect(final.messages[2]?.role).toBe('user')
      expect(final.messages[3]?.role).toBe('agent')
    })
  })
})
