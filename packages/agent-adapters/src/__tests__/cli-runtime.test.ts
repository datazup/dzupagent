import { EventEmitter } from 'node:events'
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { CliHomeProjection } from '../cli-runtime/types.js'
import { runJsonlProcess } from '../cli-runtime/run-jsonl-process.js'
import { createCliHomeProjection, createTemporaryProjection } from '../cli-runtime/temporary-projection.js'

async function collect(iterable: AsyncIterable<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = []
  for await (const value of iterable) values.push(value)
  return values
}

function createInjectedChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough } {
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

function createTrackedHomeProjection(cleanup: () => Promise<void> | void): CliHomeProjection {
  return {
    root: '/tmp/dzupagent-tracked-home',
    env: { TEST_CLI_HOME: '/tmp/dzupagent-tracked-home' },
    generatedPaths: Object.freeze({ config: '/tmp/dzupagent-tracked-home/config.json' }),
    baseProfilePaths: Object.freeze({}),
    requiredDirectories: Object.freeze(['/tmp/dzupagent-tracked-home/sessions']),
    cleanup,
  }
}

describe('bounded CLI runtime', () => {
  it('streams a normal zero-exit JSONL process without timeout, abort, or overflow classification', async () => {
    const records = await collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write(JSON.stringify({type:'ok',value:1})+'\\n')`],
      timeoutMs: 5_000,
      limits: { stdoutBytes: 1024, lineBytes: 1024, records: 4 },
    }))

    expect(records).toEqual([{ type: 'ok', value: 1 }])
  })

  it('classifies timeout and terminates the child', async () => {
    const child = createInjectedChild()
    const killed: NodeJS.Signals[] = []
    await expect(collect(runJsonlProcess({
      command: 'mock-codex',
      args: [],
      timeoutMs: 40,
      terminationGraceMs: 20,
    }, {
      spawn: (_command: string, _args: readonly string[], _options: SpawnOptions) => child,
      setTimer: ((callback: (...args: unknown[]) => void) => {
        const timer = setTimeout(callback, 0)
        return timer
      }) as typeof setTimeout,
      killProcessTree: (_child, signal) => {
        killed.push(signal)
        child.signalCode = signal
        child.stdout.end()
        child.stderr.end()
        setTimeout(() => child.emit('close', null, signal), 0)
      },
    })))
      .rejects.toMatchObject({ code: 'ADAPTER_TIMEOUT' })

    expect(killed).toContain('SIGTERM')
  })

  it('rejects output overflow before yielding an oversized record', async () => {
    await expect(collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write(JSON.stringify({value:'x'.repeat(4096)})+'\\n')`],
      limits: { stdoutBytes: 128 },
    }))).rejects.toMatchObject({ code: 'ADAPTER_EXECUTION_FAILED', context: expect.objectContaining({ classification: 'output_overflow' }) })
  })

  it('classifies malformed JSONL in strict mode', async () => {
    await expect(collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write('not-json\\n')`],
      malformedLinePolicy: 'error',
    }))).rejects.toMatchObject({ code: 'ADAPTER_EXECUTION_FAILED', context: expect.objectContaining({ classification: 'malformed_stream' }) })
  })

  it('bounds malformed-line diagnostic capture independently of stream progress', async () => {
    const diagnostics: string[] = []
    await collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write('one\\ntwo\\nthree\\n')`],
      limits: { diagnostics: 2 },
    }, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message) }))
    expect(diagnostics).toEqual(['one', 'two'])
  })

  it('escalates an abort when a child ignores SIGTERM', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 80)
    await expect(collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],
      signal: controller.signal,
      terminationGraceMs: 20,
    }))).rejects.toMatchObject({ code: 'AGENT_ABORTED' })
  })

  it('keeps concurrent cleanup and abort state isolated across independent runs', async () => {
    const abortController = new AbortController()
    const successful = collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `setTimeout(()=>process.stdout.write(JSON.stringify({run:'success'})+'\\n'),20)`],
      timeoutMs: 5_000,
    }))
    const aborted = collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `setInterval(()=>{},1000)`],
      signal: abortController.signal,
      terminationGraceMs: 20,
    }))
    const abortedExpectation = expect(aborted).rejects.toMatchObject({ code: 'AGENT_ABORTED' })

    setTimeout(() => abortController.abort(), 30)

    await expect(successful).resolves.toEqual([{ run: 'success' }])
    await abortedExpectation
  })

  it('terminates an isolated child when the JSONL generator is returned early', async () => {
    const child = createInjectedChild()
    const killed: NodeJS.Signals[] = []
    const generator = runJsonlProcess({
      command: 'mock-codex',
      args: [],
    }, {
      spawn: (_command: string, _args: readonly string[], _options: SpawnOptions) => child,
      killProcessTree: (_child, signal) => {
        killed.push(signal)
      },
    })

    const first = generator.next()
    child.stdout.write('{"event":"first"}\n')
    await expect(first).resolves.toMatchObject({
      done: false,
      value: { event: 'first' },
    })

    await generator.return(undefined)

    expect(killed).toEqual(['SIGTERM'])
    expect(child.exitCode).toBeNull()
  })

  it('cleans an attached private home once after process success and exposes cleanup telemetry', async () => {
    const cleanup = vi.fn(async () => undefined)
    const diagnostics: string[] = []

    const records = await collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write(JSON.stringify({home:process.env.TEST_CLI_HOME})+'\\n')`],
      homeProjection: createTrackedHomeProjection(cleanup),
    }, {
      onDiagnostic: (diagnostic) => diagnostics.push(`${diagnostic.kind}:${diagnostic.metadata?.['status'] ?? 'created'}`),
    }))

    expect(records).toEqual([{ home: '/tmp/dzupagent-tracked-home' }])
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(diagnostics).toEqual([
      'cli_home_projection_created:created',
      'cli_home_projection_cleanup_status:success',
    ])
  })

  it('cleans an attached private home once after failure, timeout, abort, overflow, spawn failure, and early return', async () => {
    const scenarios: Array<{
      name: string
      rejects: boolean
      execute: (projection: CliHomeProjection) => Promise<unknown>
    }> = [
      {
        name: 'non-zero failure',
        rejects: true,
        execute: (homeProjection) => collect(runJsonlProcess({
          command: process.execPath,
          args: ['-e', 'process.exit(7)'],
          homeProjection,
        })),
      },
      {
        name: 'timeout after prior process failure path',
        rejects: true,
        execute: (homeProjection) => {
          const child = createInjectedChild()
          return collect(runJsonlProcess({
            command: 'mock-timeout',
            args: [],
            timeoutMs: 20,
            terminationGraceMs: 10,
            homeProjection,
          }, {
            spawn: () => child,
            setTimer: ((callback: (...args: unknown[]) => void) => setTimeout(callback, 0)) as typeof setTimeout,
            killProcessTree: (_child, signal) => {
              child.signalCode = signal
              child.stdout.end()
              child.stderr.end()
              setTimeout(() => child.emit('close', null, signal), 0)
            },
          }))
        },
      },
      {
        name: 'abort after prior timeout path',
        rejects: true,
        execute: (homeProjection) => {
          const controller = new AbortController()
          setTimeout(() => controller.abort(), 20)
          return collect(runJsonlProcess({
            command: process.execPath,
            args: ['-e', `setInterval(()=>{},1000)`],
            signal: controller.signal,
            terminationGraceMs: 20,
            homeProjection,
          }))
        },
      },
      {
        name: 'overflow after prior abort path',
        rejects: true,
        execute: (homeProjection) => collect(runJsonlProcess({
          command: process.execPath,
          args: ['-e', `process.stdout.write(JSON.stringify({value:'x'.repeat(4096)})+'\\n')`],
          limits: { stdoutBytes: 128 },
          homeProjection,
        })),
      },
      {
        name: 'spawn failure after prior overflow path',
        rejects: true,
        execute: (homeProjection) => collect(runJsonlProcess({
          command: 'definitely-missing-dzupagent-cli',
          args: [],
          homeProjection,
        })),
      },
      {
        name: 'early return after prior spawn failure path',
        rejects: false,
        execute: async (homeProjection) => {
          const child = createInjectedChild()
          const generator = runJsonlProcess({
            command: 'mock-early-return',
            args: [],
            homeProjection,
          }, {
            spawn: () => child,
            killProcessTree: () => {
              child.stdout.end()
              child.stderr.end()
            },
          })
          const first = generator.next()
          child.stdout.write('{"event":"first"}\n')
          await first
          await generator.return(undefined)
        },
      },
    ]

    for (const scenario of scenarios) {
      const cleanup = vi.fn(async () => undefined)
      const result = scenario.execute(createTrackedHomeProjection(cleanup))
      if (scenario.rejects) await expect(result, scenario.name).rejects.toBeDefined()
      else await expect(result, scenario.name).resolves.toBeUndefined()
      expect(cleanup, scenario.name).toHaveBeenCalledTimes(1)
    }
  })

  it('validates working directories before spawning', async () => {
    await expect(collect(runJsonlProcess({ command: process.execPath, args: [], cwd: '/definitely/missing/dzupagent-cwd' })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

describe('temporary projection', () => {
  it('creates private execution-local files and cleans them idempotently', async () => {
    const projection = await createTemporaryProjection('dzupagent-test-', {
      config: { path: 'nested/config.json', content: '{"ok":true}' },
    })
    expect(await readFile(projection.paths['config']!, 'utf8')).toBe('{"ok":true}')
    await projection.cleanup()
    await projection.cleanup()
    await expect(access(projection.root)).rejects.toBeDefined()
  })

  it('rejects projection path traversal', async () => {
    await expect(createTemporaryProjection('dzupagent-test-', {
      escape: { path: '../escape', content: 'no' },
    })).rejects.toThrow('contained')
  })

  it('rejects Windows absolute paths on every host platform', async () => {
    await expect(createTemporaryProjection('dzupagent-test-', {
      escape: { path: 'C:\\Users\\escape.json', content: 'no' },
    })).rejects.toThrow('relative')
  })
})

describe('CLI home projection', () => {
  it('projects generated UTF-8 files and approved base-profile files under a unique private home', async () => {
    const approvedRoot = await mkdtemp(resolve(tmpdir(), 'dzupagent-approved-profile-'))
    await mkdir(join(approvedRoot, 'profile'), { recursive: true })
    const source = join(approvedRoot, 'profile', 'settings.json')
    await writeFile(source, '{"profile":true}', 'utf8')

    const projection = await createCliHomeProjection({
      prefix: 'dzupagent-home-',
      envVar: 'CODEX_HOME',
      approvedBaseProfileRoots: [approvedRoot],
      requiredDirectories: ['mcp', 'sessions'],
      generatedFiles: {
        config: { path: 'config/config.json', content: '{"generated":true}' },
      },
      baseProfileInputs: {
        settings: { sourcePath: source, targetPath: 'profile/settings.json' },
      },
    })

    expect(projection.env).toEqual({ CODEX_HOME: projection.root })
    expect(projection.generatedPaths['config']?.startsWith(projection.root)).toBe(true)
    expect(projection.baseProfilePaths['settings']?.startsWith(projection.root)).toBe(true)
    expect(projection.requiredDirectories.every((path) => path.startsWith(projection.root))).toBe(true)
    expect(await readFile(projection.generatedPaths['config']!, 'utf8')).toBe('{"generated":true}')
    expect(await readFile(projection.baseProfilePaths['settings']!, 'utf8')).toBe('{"profile":true}')

    await projection.cleanup()
    await projection.cleanup()
    await expect(access(projection.root)).rejects.toBeDefined()
  })

  it('rejects absolute and parent-traversal projected home paths without creating the file', async () => {
    await expect(createCliHomeProjection({
      prefix: 'dzupagent-home-',
      generatedFiles: {
        absolute: { path: '/tmp/escape.json', content: 'no' },
      },
    })).rejects.toThrow('relative')

    await expect(createCliHomeProjection({
      prefix: 'dzupagent-home-',
      requiredDirectories: ['../escape'],
      generatedFiles: {
        traversal: { path: 'ok/config.json', content: 'no' },
      },
    })).rejects.toThrow('contained')
  })

  it('rejects base-profile symlink escapes outside approved roots', async () => {
    const approvedRoot = await mkdtemp(resolve(tmpdir(), 'dzupagent-approved-profile-'))
    const outsideRoot = await mkdtemp(resolve(tmpdir(), 'dzupagent-outside-profile-'))
    const outsideFile = join(outsideRoot, 'credentials.json')
    const linkedFile = join(approvedRoot, 'credentials-link.json')
    await writeFile(outsideFile, '{"secret":true}', 'utf8')
    await symlink(outsideFile, linkedFile)

    await expect(createCliHomeProjection({
      prefix: 'dzupagent-home-',
      approvedBaseProfileRoots: [approvedRoot],
      baseProfileInputs: {
        credentials: { sourcePath: linkedFile, targetPath: 'profile/credentials.json' },
      },
    })).rejects.toThrow('approved root')
  })

  it('keeps concurrent homes, config, session roots, output, cancellation, and cleanup isolated', async () => {
    const first = await createCliHomeProjection({
      prefix: 'dzupagent-home-',
      envVar: 'TEST_CLI_HOME',
      requiredDirectories: ['sessions'],
      generatedFiles: { config: { path: 'config.json', content: '{"shared":true}' } },
    })
    const second = await createCliHomeProjection({
      prefix: 'dzupagent-home-',
      envVar: 'TEST_CLI_HOME',
      requiredDirectories: ['sessions'],
      generatedFiles: { config: { path: 'config.json', content: '{"shared":true}' } },
    })
    const abortController = new AbortController()

    const successful = collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', [
        `const fs=require('node:fs')`,
        `setTimeout(()=>{`,
        `const config=fs.readFileSync(process.env.TEST_CLI_HOME+'/config.json','utf8')`,
        `process.stdout.write(JSON.stringify({run:'success',home:process.env.TEST_CLI_HOME,config})+'\\n')`,
        `},80)`,
      ].join(';')],
      homeProjection: first,
    }))
    const aborted = collect(runJsonlProcess({
      command: process.execPath,
      args: ['-e', `setInterval(()=>{},1000)`],
      signal: abortController.signal,
      terminationGraceMs: 20,
      homeProjection: second,
    }))

    expect(first.root).not.toBe(second.root)
    expect(first.generatedPaths['config']).not.toBe(second.generatedPaths['config'])
    setTimeout(() => abortController.abort(), 20)
    await expect(aborted).rejects.toMatchObject({ code: 'AGENT_ABORTED' })
    await expect(access(first.root)).resolves.toBeUndefined()
    await expect(access(second.root)).rejects.toBeDefined()
    await expect(successful).resolves.toEqual([{ run: 'success', home: first.root, config: '{"shared":true}' }])
    await expect(access(first.root)).rejects.toBeDefined()
  })
})
