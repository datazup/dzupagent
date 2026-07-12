import { access, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { ClaudeCliAdapter } from '../claude/claude-cli-adapter.js'
import { createClaudeBackendAdapter } from '../claude/claude-backend.js'
import { ClaudeAgentAdapter } from '../claude/claude-adapter.js'
import type { PreparedCliRun } from '../base/base-cli-adapter.js'
import type { AgentEvent, AgentInput } from '../types.js'

class InspectableClaudeCliAdapter extends ClaudeCliAdapter {
  args(input: AgentInput): string[] { return this.buildArgs(input) }
  prepare(input: AgentInput): Promise<PreparedCliRun> { return this.prepareCliRun(input) }
  map(record: Record<string, unknown>, sessionId = 'fallback'): AgentEvent | AgentEvent[] | undefined { return this.mapProviderEvent(record, sessionId) }
}

describe('Claude local CLI backend', () => {
  it('materializes exactly one explicitly selected backend', () => {
    expect(createClaudeBackendAdapter({ backend: 'cli' })).toBeInstanceOf(ClaudeCliAdapter)
    expect(createClaudeBackendAdapter({ backend: 'sdk' })).toBeInstanceOf(ClaudeAgentAdapter)
  })
  it('uses the verified read-only denylist and stream-json output', () => {
    const args = new InspectableClaudeCliAdapter().args({ prompt: 'inspect', workingDirectory: '/tmp' })
    expect(args).toEqual(expect.arrayContaining(['--print', '--output-format', 'stream-json', '--disallowedTools', 'Write', 'Edit', 'Bash', 'NotebookEdit']))
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args.slice(-2)).toEqual(['--', 'inspect'])
  })

  it('rejects strict workspace-write allowlist projection', () => {
    expect(() => new InspectableClaudeCliAdapter().args({
      prompt: 'edit',
      policyContext: { conformanceMode: 'strict', activePolicy: { sandboxMode: 'workspace-write', allowedTools: ['Edit'] } },
    })).toThrow('does not enforce a strict allowlist')
  })

  it('rejects unsupported max-turn projection instead of ignoring it', () => {
    expect(() => new InspectableClaudeCliAdapter().args({ prompt: 'bounded', maxTurns: 2 })).toThrow('max-turns')
  })

  it('projects MCP references into distinct private files and cleans each run', async () => {
    const adapter = new InspectableClaudeCliAdapter()
    const input: AgentInput = {
      prompt: 'use tools',
      options: {
        mcpServers: [{ id: 'local', transport: { kind: 'stdio', command: 'node', args: ['server.js'], envRefs: { AUTH: 'local-auth' } }, disabledTools: ['delete'] }],
        mcpReferenceValues: { 'local-auth': 'secret-value' },
      },
    }
    const [first, second] = await Promise.all([adapter.prepare(input), adapter.prepare(input)])
    const firstPath = first.args[first.args.indexOf('--mcp-config') + 1]!
    const secondPath = second.args[second.args.indexOf('--mcp-config') + 1]!
    expect(firstPath).not.toBe(secondPath)
    expect(first.args).toContain('mcp__local__delete')
    expect(first.args.indexOf('--mcp-config')).toBeLessThan(first.args.indexOf('--'))
    expect(JSON.parse(await readFile(firstPath, 'utf8'))).toEqual({ mcpServers: { local: { type: 'stdio', command: 'node', args: ['server.js'], env: { AUTH: 'secret-value' } } } })
    await Promise.all([first.cleanup?.(), second.cleanup?.()])
    await expect(access(firstPath)).rejects.toBeDefined()
    await expect(access(secondPath)).rejects.toBeDefined()
  })

  it('maps Claude stream, tool, usage, structured output, and session records', () => {
    const adapter = new InspectableClaudeCliAdapter()
    expect(adapter.map({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'hi' } } })).toMatchObject({ type: 'adapter:stream_delta', content: 'hi' })
    expect(adapter.map({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } }] } })).toEqual([expect.objectContaining({ type: 'adapter:tool_call', toolName: 'Read', toolCallId: 't1' })])
    expect(adapter.map({ type: 'result', subtype: 'success', session_id: 's1', structured_output: { ok: true }, usage: { input_tokens: 2, output_tokens: 3 }, duration_ms: 4 })).toMatchObject({ type: 'adapter:completed', sessionId: 's1', result: '{"ok":true}', usage: { inputTokens: 2, outputTokens: 3 } })
  })
})
