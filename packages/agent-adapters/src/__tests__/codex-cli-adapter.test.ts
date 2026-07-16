import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ForgeError } from '@dzupagent/core/events'
import { CodexAdapter } from '../codex/codex-adapter.js'
import { CodexCliAdapter } from '../codex/codex-cli-adapter.js'
import { createCodexBackendAdapter } from '../codex/codex-backend.js'
import type { AgentInput, AgentStreamEvent } from '../types.js'

function createChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough } {
  const child = new EventEmitter() as ChildProcess & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    pid: number
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.pid = Math.floor(Math.random() * 10_000) + 1
  child.kill = vi.fn()
  return child
}

async function collect(gen: AsyncGenerator<AgentStreamEvent, void, undefined>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

describe('Codex explicit CLI backend', () => {
  it('materializes exactly the explicit backend and keeps SDK as the default', () => {
    expect(createCodexBackendAdapter()).toBeInstanceOf(CodexAdapter)
    expect(createCodexBackendAdapter({ backend: 'sdk' })).toBeInstanceOf(CodexAdapter)
    expect(createCodexBackendAdapter({ backend: 'cli' })).toBeInstanceOf(CodexCliAdapter)
  })

  it('maps read-only and workspace-write args without forwarding API keys or subscription credentials', async () => {
    const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
    const adapter = new CodexCliAdapter({
      apiKey: 'sk-secret-value',
      cliPath: 'codex-test',
      env: {
        OPENAI_API_KEY: 'sk-secret-value',
        CODEX_SUBSCRIPTION_TOKEN: 'subscription-secret',
        SAFE_FLAG: 'ok',
      },
      runtimeDependencies: {
        spawn: (command, args, options) => {
          spawned.push({ command, args, options })
          const child = createChild()
          queueMicrotask(() => {
            child.stdout.write('{"type":"agent_message","text":"ok"}\n')
            child.stdout.write('{"type":"turn_completed","result":"done"}\n')
            child.stdout.end()
            child.stderr.end()
            child.exitCode = 0
            child.emit('close', 0, null)
          })
          return child
        },
      },
    })

    await collect(adapter.executeWithRaw({ prompt: 'inspect', workingDirectory: process.cwd() }))
    const first = spawned[0]!
    expect(first.args).toEqual(expect.arrayContaining(['--ask-for-approval', 'on-request', '--sandbox', 'read-only', 'exec', '--json', '--', 'inspect']))
    expect(first.args).not.toContain('--model')
    expect(JSON.stringify(first.args)).not.toContain('sk-secret-value')
    expect(JSON.stringify(first.options.env)).not.toContain('sk-secret-value')
    expect(JSON.stringify(first.options.env)).not.toContain('subscription-secret')
    expect(first.options.env).toMatchObject({ SAFE_FLAG: 'ok' })
    expect(first.options.env).toMatchObject({ PATH: process.env.PATH })
    expect(first.options.env).toMatchObject({ CODEX_HOME: expect.stringContaining('dzupagent-codex-') })

    spawned.length = 0
    await collect(adapter.executeWithRaw({
      prompt: 'write',
      workingDirectory: process.cwd(),
      policyContext: { activePolicy: { sandboxMode: 'workspace-write', approvalRequired: false } },
    }))
    expect(spawned[0]!.args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write', '--ask-for-approval', 'never']))
  })

  it('uses the installed CLI argument contract for reasoning, resume, and file-backed output schemas', async () => {
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    const adapter = new CodexCliAdapter({
      reasoning: 'high',
      runtimeDependencies: {
        spawn: (_command, args, options) => {
          calls.push({ args, env: options.env ?? {} })
          const child = createChild()
          queueMicrotask(() => {
            child.stdout.write('{"type":"turn_completed","result":"ok"}\n')
            child.stdout.end()
            child.stderr.end()
            child.exitCode = 0
            child.emit('close', 0, null)
          })
          return child
        },
      },
    })

    await collect(adapter.executeWithRaw({
      prompt: 'continue',
      resumeSessionId: 'session-1',
      outputSchema: { type: 'object' },
    }))

    const args = calls[0]!.args
    expect(args).toEqual(expect.arrayContaining([
      '--config', 'model_reasoning_effort="high"', 'exec', 'resume', '--json', '--output-schema',
    ]))
    expect(args).not.toContain('--reasoning')
    expect(args).not.toContain('--approval-policy')
    expect(args).not.toContain('--resume')
    const schemaPath = args[args.indexOf('--output-schema') + 1]!
    expect(schemaPath).toBe(join(String(calls[0]!.env.CODEX_HOME), 'output-schema.json'))
    expect(args.slice(-3)).toEqual(['--', 'session-1', 'continue'])
  })

  it('normalizes installed CLI dotted envelopes and carries the final assistant message into completion', async () => {
    const adapter = new CodexCliAdapter({
      runtimeDependencies: {
        spawn: () => {
          const child = createChild()
          queueMicrotask(() => {
            child.stdout.write('{"type":"thread.started","thread_id":"cli-thread-1"}\n')
            child.stdout.write('{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"final answer"}}\n')
            child.stdout.write('{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":2}}\n')
            child.stdout.end()
            child.stderr.end()
            child.exitCode = 0
            child.emit('close', 0, null)
          })
          return child
        },
      },
    })

    const events = await collect(adapter.executeWithRaw({ prompt: 'dotted events' }))
    expect(events.find((event) => event.type === 'adapter:message')).toMatchObject({ content: 'final answer' })
    expect(events.findLast((event) => event.type === 'adapter:completed')).toMatchObject({
      result: 'final answer',
      usage: { inputTokens: 7, outputTokens: 2 },
    })
  })

  it('copies approved local auth state into the private CODEX_HOME without mutating the base profile', async () => {
    const baseRoot = await mkdtemp(join(tmpdir(), 'dzupagent-codex-base-'))
    const authPath = join(baseRoot, 'auth.json')
    await writeFile(authPath, '{"auth_mode":"chatgpt"}\n', { mode: 0o600 })
    let projectedAuth = ''
    try {
      const adapter = new CodexCliAdapter({
        cliBaseProfileRoot: baseRoot,
        cliBaseProfileFiles: ['auth.json'],
        runtimeDependencies: {
          spawn: (_command, _args, options) => {
            const child = createChild()
            queueMicrotask(async () => {
              projectedAuth = await readFile(join(String(options.env?.CODEX_HOME), 'auth.json'), 'utf8')
              child.stdout.write('{"type":"turn_completed","result":"ok"}\n')
              child.stdout.end()
              child.stderr.end()
              child.exitCode = 0
              child.emit('close', 0, null)
            })
            return child
          },
        },
      })

      await collect(adapter.executeWithRaw({ prompt: 'auth' }))
      expect(projectedAuth).toBe('{"auth_mode":"chatgpt"}\n')
      expect(await readFile(authPath, 'utf8')).toBe('{"auth_mode":"chatgpt"}\n')
    } finally {
      await rm(baseRoot, { recursive: true, force: true })
    }
  })

  it('projects authenticated HTTP MCP through private config and a reference-backed bearer environment variable', async () => {
    let projectedConfig = ''
    let projectedEnv: NodeJS.ProcessEnv = {}
    let projectedArgs: readonly string[] = []
    const adapter = new CodexCliAdapter({
      runtimeDependencies: {
        spawn: (_command, args, options) => {
          const child = createChild()
          queueMicrotask(async () => {
            projectedArgs = args
            projectedEnv = options.env ?? {}
            projectedConfig = await readFile(join(String(options.env?.CODEX_HOME), 'config.toml'), 'utf8')
            child.stdout.write('{"type":"turn_completed","result":"ok"}\n')
            child.stdout.end()
            child.stderr.end()
            child.exitCode = 0
            child.emit('close', 0, null)
          })
          return child
        },
      },
    })

    await collect(adapter.executeWithRaw({
      prompt: 'use worker tools',
      options: {
        mcpServers: [{
          id: 'codev_worker',
          transport: {
            kind: 'http',
            url: 'http://127.0.0.1:7821',
            bearerTokenEnv: { envVar: 'CODEV_MCP_TOKEN', tokenRef: 'worker-token' },
          },
        }],
        mcpReferenceValues: { 'worker-token': 'raw-token-value' },
      },
    }))

    expect(projectedConfig).toContain('[mcp_servers."codev_worker"]')
    expect(projectedConfig).toContain('url = "http://127.0.0.1:7821/"')
    expect(projectedConfig).toContain('enabled = true')
    expect(projectedConfig).toContain('required = true')
    expect(projectedConfig).toContain('bearer_token_env_var = "CODEV_MCP_TOKEN"')
    expect(projectedConfig).not.toContain('raw-token-value')
    expect(projectedEnv.CODEV_MCP_TOKEN).toBe('raw-token-value')
    expect(projectedArgs).toEqual(expect.arrayContaining([
      '--disable', 'apps', '--disable', 'plugins', '--disable', 'enable_mcp_apps',
    ]))
  })

  it('rejects unresolved, materialized-header, and unsafe bearer MCP projections before spawn', async () => {
    const spawn = vi.fn()
    const adapter = new CodexCliAdapter({ runtimeDependencies: { spawn } })
    const base = { id: 'worker', transport: { kind: 'http' as const, url: 'http://127.0.0.1:7821' } }

    await expect(collect(adapter.executeWithRaw({
      prompt: 'missing ref',
      options: {
        mcpServers: [{ ...base, transport: { ...base.transport, bearerTokenEnv: { envVar: 'CODEV_MCP_TOKEN', tokenRef: 'missing' } } }],
      },
    }))).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(collect(adapter.executeWithRaw({
      prompt: 'headers',
      options: { mcpServers: [{ ...base, transport: { ...base.transport, headerRefs: { Authorization: 'secret-ref' } } }] },
    }))).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(collect(adapter.executeWithRaw({
      prompt: 'unsafe env',
      options: {
        mcpServers: [{ ...base, transport: { ...base.transport, bearerTokenEnv: { envVar: 'bad-name', tokenRef: 'token' } } }],
        mcpReferenceValues: { token: 'value' },
      },
    }))).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects unsupported policy and MCP combinations before spawn after a prior successful run', async () => {
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
      const child = createChild()
      queueMicrotask(() => {
        child.stdout.write('{"type":"turn_completed","result":"ok"}\n')
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 0
        child.emit('close', 0, null)
      })
      return child
    })
    const adapter = new CodexCliAdapter({ runtimeDependencies: { spawn } })

    await expect(collect(adapter.executeWithRaw({ prompt: 'ok' }))).resolves.toEqual(expect.any(Array))
    expect(spawn).toHaveBeenCalledTimes(1)

    await expect(collect(adapter.executeWithRaw({ prompt: 'bad', options: { sandboxMode: 'full-access' } })))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    await expect(collect(adapter.executeWithRaw({ prompt: 'mcp', options: { mcpServers: [{ id: 'local' }] } })))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('maps raw, normalized, structured output, auth failure, timeout, cancellation, overflow, and cleanup without SDK fallback', async () => {
    const cleanupRoots: string[] = []
    const spawn = vi.fn((_command: string, args: readonly string[], _options: SpawnOptions) => {
      const child = createChild()
      queueMicrotask(() => {
        if (args.includes('auth-fail')) {
          child.stdout.write('{"type":"error","message":"auth login required","code":"auth_required"}\n')
          child.stdout.end()
          child.stderr.end()
          child.exitCode = 0
          child.emit('close', 0, null)
          return
        }
        child.stdout.write('{"type":"agent_message","text":"hello"}\n')
        child.stdout.write('{"type":"turn_completed","result":"{\\"ok\\":true}","usage":{"input_tokens":2,"output_tokens":3},"duration_ms":4}\n')
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 0
        child.emit('close', 0, null)
      })
      return child
    })
    const adapter = new CodexCliAdapter({
      runtimeDependencies: {
        spawn,
        onDiagnostic: (diagnostic) => {
          if (diagnostic.kind === 'cli_home_projection_cleanup_status') cleanupRoots.push(String(diagnostic.metadata?.['root']))
        },
      },
    })

    const events = await collect(adapter.executeWithRaw({
      prompt: 'structured',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    }))
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['adapter:started', 'adapter:provider_raw', 'adapter:message', 'adapter:completed']))
    expect(events.find((event) => event.type === 'adapter:completed')).toMatchObject({ result: '{"ok":true}', usage: { inputTokens: 2, outputTokens: 3 } })

    const authEvents = await collect(adapter.executeWithRaw({ prompt: 'auth-fail' }))
    expect(authEvents.find((event) => event.type === 'adapter:failed')).toMatchObject({ code: 'ADAPTER_AUTH_FAILED' })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(cleanupRoots).toHaveLength(2)

    const timeoutChild = createChild()
    const timeoutAdapter = new CodexCliAdapter({
      timeoutMs: 20,
      runtimeDependencies: {
        spawn: () => timeoutChild,
        setTimer: ((callback: (...args: unknown[]) => void) => setTimeout(callback, 0)) as typeof setTimeout,
        killProcessTree: (_child, signal) => {
          timeoutChild.signalCode = signal
          timeoutChild.stdout.end()
          timeoutChild.stderr.end()
          setTimeout(() => timeoutChild.emit('close', null, signal), 0)
        },
      },
    })
    await expect(collect(timeoutAdapter.executeWithRaw({ prompt: 'timeout' }))).rejects.toMatchObject({ code: 'ADAPTER_TIMEOUT' })

    const controller = new AbortController()
    const cancelAdapter = new CodexCliAdapter({
      runtimeDependencies: {
        spawn: () => createChild(),
        killProcessTree: (child, signal) => {
          child.stdout?.end()
          child.stderr?.end()
          setTimeout(() => child.emit('close', null, signal), 0)
        },
      },
    })
    setTimeout(() => controller.abort(), 0)
    await expect(collect(cancelAdapter.executeWithRaw({ prompt: 'cancel', signal: controller.signal }))).rejects.toMatchObject({ code: 'AGENT_ABORTED' })

    const overflowAdapter = new CodexCliAdapter({
      runtimeLimits: { stdoutBytes: 64 },
      runtimeDependencies: {
        spawn: () => {
          const child = createChild()
          queueMicrotask(() => child.stdout.write(`{"type":"agent_message","text":"${'x'.repeat(256)}"}\n`))
          return child
        },
        killProcessTree: (child, signal) => {
          child.stdout?.end()
          child.stderr?.end()
          setTimeout(() => child.emit('close', null, signal), 0)
        },
      },
    })
    await expect(collect(overflowAdapter.executeWithRaw({ prompt: 'overflow' }))).rejects.toBeInstanceOf(ForgeError)
  })

  it('keeps concurrent run state isolated when one run overflows and another succeeds', async () => {
    const spawn = vi.fn((_command: string, args: readonly string[], _options: SpawnOptions) => {
      const child = createChild()
      queueMicrotask(() => {
        if (args.includes('overflow')) {
          child.stdout.write(`{"type":"agent_message","text":"${'x'.repeat(512)}"}\n`)
          return
        }
        child.stdout.write('{"type":"turn_completed","result":"done"}\n')
        child.stdout.end()
        child.stderr.end()
        child.exitCode = 0
        child.emit('close', 0, null)
      })
      return child
    })
    const adapter = new CodexCliAdapter({
      runtimeLimits: { stdoutBytes: 80 },
      runtimeDependencies: {
        spawn,
        killProcessTree: (child, signal) => {
          child.stdout?.end()
          child.stderr?.end()
          setTimeout(() => child.emit('close', null, signal), 0)
        },
      },
    })

    const failed = collect(adapter.executeWithRaw({ prompt: 'overflow' }))
    const succeeded = collect(adapter.executeWithRaw({ prompt: 'success' }))

    await expect(failed).rejects.toBeDefined()
    await expect(succeeded).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'adapter:completed', result: 'done' }),
    ]))
  })
})
