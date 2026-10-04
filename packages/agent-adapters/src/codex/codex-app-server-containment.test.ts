import { spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { CodexAppServerStdioClient } from './codex-app-server-client.js'
import { buildCodexContainedCommand, codexJoinReceipt } from './codex-app-server-containment.js'

const DIGEST = `sha256:${'b'.repeat(64)}`
const stubs = {
  realpath: async (path: string) => path,
  stat: async () => ({ isFile: () => true }),
  access: async () => undefined,
  digestArtifact: async () => DIGEST,
}

describe('buildCodexContainedCommand', () => {
  it('wraps the app-server argv in a read-only PID namespace', () => {
    const built = buildCodexContainedCommand({ writablePaths: ['/work/tree'] }, '/bin/codex', ['app-server', '--stdio'])
    expect(built.command).toBe('bwrap')
    expect(built.args.slice(0, 2)).toEqual(['--unshare-pid', '--die-with-parent'])
    expect(built.args).toContain('--ro-bind')
    expect(built.args).toEqual(expect.arrayContaining(['--bind', '/work/tree']))
    expect(built.args.slice(-3)).toEqual(['/bin/codex', 'app-server', '--stdio'])
    expect(built.args[built.args.length - 4]).toBe('--')
    const again = buildCodexContainedCommand({ writablePaths: ['/work/tree'] }, '/bin/codex', ['app-server', '--stdio'])
    expect(again.argvDigest).toBe(built.argvDigest)
    expect(built.argvDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(buildCodexContainedCommand({ writablePaths: [] }, '/bin/codex', ['app-server', '--stdio']).argvDigest)
      .not.toBe(built.argvDigest)
  })

  it.each(['relative/path', '/', ''])('rejects writable path %j', path => {
    expect(() => buildCodexContainedCommand({ writablePaths: [path] }, '/bin/codex', [])).toThrow(TypeError)
  })
})

describe('codexJoinReceipt', () => {
  it('is never joined without an exit, and not joined when a signal ended the outer process', () => {
    expect(codexJoinReceipt('d', undefined).joined).toBe(false)
    expect(codexJoinReceipt('d', { code: null, signal: 'SIGTERM' })).toMatchObject({ joined: false, signal: 'SIGTERM' })
    expect(codexJoinReceipt('d', { code: 3, signal: null })).toMatchObject({ joined: true, exitCode: 3 })
  })
})

function fakeSpawn(): { child: ChildProcess, spawn: (...args: unknown[]) => ChildProcess, calls: unknown[][] } {
  const child = new EventEmitter() as ChildProcess
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: () => true })
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      const frame = JSON.parse(line) as { id?: number, method?: string }
      if (frame.method === 'initialize') {
        stdout.write(JSON.stringify({
          id: frame.id,
          result: { codexHome: '/h', platformFamily: 'unix', platformOs: 'linux', userAgent: 'x/1' },
        }) + '\n')
      }
    }
  })
  const calls: unknown[][] = []
  return { child, calls, spawn: (...args: unknown[]) => { calls.push(args); return child } }
}

const executable = { name: 'codex', path: '/fixture/codex', realPath: '/fixture/codex', artifactDigest: DIGEST }

describe('contained client receipt', () => {
  it('has no receipt unless containment is requested', async () => {
    const fake = fakeSpawn()
    const client = await CodexAppServerStdioClient.connect({
      executable, dependencies: { ...stubs, spawn: fake.spawn as never },
    })
    expect(fake.calls[0]?.[0]).toBe('/fixture/codex')
    expect(client.joinReceipt()).toBeUndefined()
    const closing = client.close()
    fake.child.emit('exit', 0, null)
    await closing
  })

  it('spawns bwrap and reports joined only after the outer exit', async () => {
    const fake = fakeSpawn()
    const client = await CodexAppServerStdioClient.connect({
      executable,
      containment: { writablePaths: ['/work/tree'] },
      limits: { cleanupTimeoutMs: 1000 },
      dependencies: { ...stubs, spawn: fake.spawn as never },
    })
    expect(fake.calls[0]?.[0]).toBe('bwrap')
    expect(fake.calls[0]?.[1]).toEqual(expect.arrayContaining(['--unshare-pid', '/fixture/codex', 'app-server', '--stdio']))
    expect(client.joinReceipt()).toMatchObject({ joined: false, exitCode: null, signal: null })
    const closing = client.close()
    await delay(20)
    expect(client.joinReceipt()?.joined).toBe(false)
    fake.child.emit('exit', 0, null)
    await closing
    expect(client.joinReceipt()).toMatchObject({ joined: true, exitCode: 0, signal: null })
    expect(client.joinReceipt()?.argvDigest).toMatch(/^sha256:/)
  })

  it('records a non-zero exit and a signal exit instead of hiding them', async () => {
    for (const [code, signal, joined] of [[7, null, true], [null, 'SIGKILL', false]] as const) {
      const fake = fakeSpawn()
      const client = await CodexAppServerStdioClient.connect({
        executable,
        containment: { writablePaths: [] },
        limits: { cleanupTimeoutMs: 1000 },
        dependencies: { ...stubs, spawn: fake.spawn as never },
      })
      const closing = client.close()
      fake.child.emit('exit', code, signal)
      await closing
      expect(client.joinReceipt()).toMatchObject({ joined, exitCode: code, signal })
    }
  })
})

const bwrapUsable = spawnSync('bwrap', ['--unshare-pid', '--ro-bind', '/', '/', 'true']).status === 0

const SERVER = `
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
const [root, kind] = process.argv.slice(2)
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\\n')
createInterface({ input: process.stdin }).on('line', async line => {
  const frame = JSON.parse(line)
  if (frame.method === 'initialize') emit({ id: frame.id, result: { codexHome: root, platformFamily: 'unix', platformOs: 'linux', userAgent: 'local-double/1' } })
  if (frame.method === 'turn/start') {
    const child = spawn(process.execPath, [join(root, 'effect.mjs'), join(root, 'release'), join(root, 'effect')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise(resolve => child.stdout.once('data', resolve))
    child.stdout.destroy()
    child.unref()
    const params = { threadId: 't', turnId: 'u', item: { id: 'e', type: kind } }
    emit({ method: 'item/started', params })
    emit({ method: 'item/completed', params: { ...params, item: { ...params.item, status: 'completed' } } })
    emit({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'completed' } } })
    emit({ id: frame.id, result: {} })
  }
})
`
const EFFECT = `
import { existsSync, writeFileSync } from 'node:fs'
const [release, effect] = process.argv.slice(2)
process.stdout.write('ready\\n')
setInterval(() => { if (existsSync(release)) { writeFileSync(effect, 'effect-after-join\\n'); process.exit(0) } }, 5)
`

async function runDouble(containment: boolean): Promise<{ effectWritten: boolean, joined: boolean | undefined }> {
  const root = mkdtempSync(join(tmpdir(), 'codex-containment-'))
  try {
    writeFileSync(join(root, 'server.mjs'), SERVER)
    writeFileSync(join(root, 'effect.mjs'), EFFECT)
    const bin = join(root, 'fake-codex')
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'server.mjs')}" "${root}" mcpToolCall\n`)
    chmodSync(bin, 0o755)
    const client = await CodexAppServerStdioClient.connect({
      executable: { name: 'codex', path: bin, realPath: bin, artifactDigest: DIGEST },
      limits: { cleanupTimeoutMs: 1000 },
      ...(containment ? { containment: { writablePaths: [root] } } : {}),
      dependencies: stubs,
    })
    await client.request('turn/start', {})
    for await (const event of client.events()) if (event.method === 'turn/completed') break
    await client.close()
    const joined = client.joinReceipt()?.joined
    // The release lands only after the receipt exists, as in the drain countermodel.
    writeFileSync(join(root, 'release'), '')
    for (let i = 0; i < 100 && !existsSync(join(root, 'effect')); i++) await delay(5)
    return { effectWritten: existsSync(join(root, 'effect')), joined }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(!bwrapUsable)('real PID-namespace containment', () => {
  it('control: without containment the effect outlives close()', async () => {
    const result = await runDouble(false)
    expect(result.joined).toBeUndefined()
    expect(result.effectWritten).toBe(true)
  })

  it('with containment no byte is written after the join receipt', async () => {
    const result = await runDouble(true)
    expect(result.joined).toBe(true)
    expect(result.effectWritten).toBe(false)
  })
})
