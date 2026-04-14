import { describe, it, expect, vi } from 'vitest'
import { createProgram } from '../cli.js'

async function parseCliArgs(args: string[]): Promise<void> {
  const program = createProgram()
  program.exitOverride()
  await program.parseAsync(args, { from: 'user' })
}

async function expectProcessExitInvoked(task: () => Promise<void>): Promise<void> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit invoked')
  }) as never)
  try {
    await expect(task()).rejects.toThrow('process.exit invoked')
  } finally {
    exitSpy.mockRestore()
  }
}

describe('CLI argument matrix', () => {
  it('--help exits via commander help path', async () => {
    await expect(parseCliArgs(['--help'])).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
      exitCode: 0,
    })
  })

  it('-h exits via commander help path', async () => {
    await expect(parseCliArgs(['-h'])).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
      exitCode: 0,
    })
  })

  it('--list parses and exits cleanly', async () => {
    await expect(parseCliArgs(['--list'])).resolves.toBeUndefined()
  })

  it('--list-presets parses and exits cleanly', async () => {
    await expect(parseCliArgs(['--list-presets'])).resolves.toBeUndefined()
  })

  it('--list-features parses and exits cleanly', async () => {
    await expect(parseCliArgs(['--list-features'])).resolves.toBeUndefined()
  })

  it('fails for unknown option', async () => {
    await expect(parseCliArgs(['--bogus'])).rejects.toMatchObject({
      code: 'commander.unknownOption',
      exitCode: 1,
    })
  })

  it('fails for missing template argument', async () => {
    await expect(parseCliArgs(['my-project', '--template'])).rejects.toMatchObject({
      code: 'commander.optionMissingArgument',
      exitCode: 1,
    })
  })

  it('requires project name when --template is provided', async () => {
    await expectProcessExitInvoked(() => parseCliArgs(['--template', 'minimal']))
  })

  it('rejects unknown template values', async () => {
    await expectProcessExitInvoked(() => parseCliArgs(['my-project', '--template', 'unknown-template']))
  })

  it('rejects unknown preset values', async () => {
    await expectProcessExitInvoked(() => parseCliArgs(['my-project', '--preset', 'unknown-preset']))
  })

  it('rejects invalid package manager values', async () => {
    await expectProcessExitInvoked(() => parseCliArgs(['my-project', '--package-manager', 'bun']))
  })
})
