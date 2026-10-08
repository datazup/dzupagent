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
test('interactive spinner stops its interval on both success and failure', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  vi.useFakeTimers()
  vi.stubEnv('NO_COLOR', undefined)
  vi.stubEnv('FORCE_COLOR', '1')
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    vi.resetModules()
    const { Spinner } = await import('../logger.js')
    const spinner = new Spinner()
    spinner.start('fixture')
    vi.advanceTimersByTime(160)
    expect(vi.getTimerCount()).toBe(1)
    spinner.succeed('complete')
    expect(vi.getTimerCount()).toBe(0)
    spinner.start('fixture')
    spinner.fail()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
    if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor)
    else Reflect.deleteProperty(process.stdout, 'isTTY')
  }
})
