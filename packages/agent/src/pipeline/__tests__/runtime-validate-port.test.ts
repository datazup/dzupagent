import { describe, expect, it } from 'vitest'
import { createRuntimeValidatePort, createRuntimeShellValidationCommandRunner } from '../tool-handlers/validation.js'
import type { RuntimeValidateRequest } from '../tool-handlers/requests.js'

const request: RuntimeValidateRequest = { nodeId: 'validate', arguments: {}, context: { state: {}, previousResults: new Map() } }

describe('createRuntimeValidatePort', () => {
  it('passes an empty suite and reports missing suites and missing runners', async () => {
    expect(await createRuntimeValidatePort()(request)).toMatchObject({ output: { valid: true, commandResults: [] } })
    expect(await createRuntimeValidatePort()({ ...request, ref: 'missing' })).toMatchObject({ error: { code: 'RUNTIME_VALIDATE_SUITE_NOT_FOUND' } })
    expect(await createRuntimeValidatePort({ suites: { fixture: [{ command: 'fixture' }] } })({ ...request, ref: 'fixture' })).toMatchObject({ error: { code: 'RUNTIME_VALIDATE_RUNNER_MISSING' } })
  })

  it('preserves runner failures and thrown runner errors as an invalid suite', async () => {
    for (const [expectedValid, runCommand] of [[true, async () => true], [false, async () => false], [false, async () => { throw 'runner unavailable' }]] as const) {
      const result = await createRuntimeValidatePort({ resolveSuite: async () => ({ commands: [{ command: 'fixture', id: 'one' }] }), runCommand })({ ...request, ref: 'fixture' })
      expect(result.output).toMatchObject({ valid: expectedValid })
    }
  })

  it('resolves configured suites and drops malformed inline command entries', async () => {
    const resolved = await createRuntimeValidatePort({ suites: { fixture: { commands: [{ command: 'fixture', id: 'fallback' }] } }, runCommand: async command => ({ command: command.command, ok: true }) })({ ...request, ref: 'fixture' })
    expect(resolved.output).toMatchObject({ commandResults: [{ id: 'fallback', ok: true }] })
    const inline = await createRuntimeValidatePort({ runCommand: async () => true })({ ...request, commands: [null, false, {}, { command: '' }, { command: 'fixture', id: 1, kind: 'invalid', schemaRef: false, dataPath: [], metadata: false }, { command: 'fixture', id: 'one', kind: 'schema', schemaRef: 'schema', dataPath: 'data', data: null, metadata: {} }] } as unknown as RuntimeValidateRequest)
    expect(inline.output).toMatchObject({ commandResults: [{ command: 'fixture', ok: true }, { id: 'one', kind: 'schema', data: null }] })
  })
})

describe('createRuntimeShellValidationCommandRunner', () => {
  it('denies every command when no allow policy is configured', async () => {
    const denied = createRuntimeShellValidationCommandRunner()
    expect(await denied({ command: 'fixture' }, request)).toMatchObject({ ok: false, metadata: { code: 'RUNTIME_VALIDATE_COMMAND_DENIED' } })
  })

  it('never executes malformed or shell-metacharacter commands even when allowed', async () => {
    const allowed = createRuntimeShellValidationCommandRunner({ allowCommand: async () => true })
    for (const command of ['', '   ', 'fixture\\', "fixture '", 'fixture & next', 'fixture | next', 'fixture ; next', 'fixture < file', 'fixture > file', 'fixture `next`']) {
      expect(await allowed({ command }, request), command).toMatchObject({ ok: false, metadata: { code: 'RUNTIME_VALIDATE_COMMAND_UNSAFE' } })
    }
  })

  it('runs allowlisted commands and reports their exit status', async () => {
    for (const command of ["node -e 'process.stdout.write(\"fixture\")'", 'node -e "process.exit(0)"', "node -e 'process.exit(2)'", 'node -e process.exit(0)']) {
      const result = await createRuntimeShellValidationCommandRunner({ allowCommands: [command] })({ command }, request)
      expect(typeof result === 'boolean' ? result : result.ok).toBe(!command.includes('exit(2)'))
    }
  })
})
