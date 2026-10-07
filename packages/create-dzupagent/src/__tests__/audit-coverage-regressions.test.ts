import { expect, test, vi, afterEach } from 'vitest'
import { Spinner, colors } from '../logger.js'

afterEach(() => vi.restoreAllMocks())
test('noninteractive progress reports success and failure without leaving timers running', () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const spinner = new Spinner()
  spinner.start('creating files')
  spinner.succeed()
  spinner.start('installing')
  spinner.fail('installation failed')
  expect(write.mock.calls.map(([text]) => text).join('')).toContain('creating files')
  expect(write.mock.calls.map(([text]) => text).join('')).toContain('installation failed')
  for (const color of Object.values(colors)) expect(color('visible')).toContain('visible')
})
