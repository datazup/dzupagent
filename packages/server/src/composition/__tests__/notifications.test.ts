/**
 * Focused tests for the env-driven notification channel registration.
 * Verifies that channels are added only when the corresponding env vars
 * are set and that no work is done when no Notifier is configured.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { registerEnvNotificationChannels } from '../notifications.js'
import type { ForgeServerConfig } from '../types.js'
import type { Notifier } from '../../notifications/notifier.js'

const ENV_KEYS = [
  'SLACK_NOTIFICATION_WEBHOOK_URL',
  'EMAIL_NOTIFICATION_WEBHOOK_URL',
  'EMAIL_NOTIFICATION_WEBHOOK_SECRET',
] as const

function snapshotAndClearEnv() {
  const saved: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  return saved
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved[key]
    }
  }
}

describe('composition/notifications', () => {
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = snapshotAndClearEnv()
  })

  afterEach(() => {
    restoreEnv(savedEnv)
    vi.restoreAllMocks()
  })

  function makeConfig(notifier?: Notifier): ForgeServerConfig {
    return { notifier } as unknown as ForgeServerConfig
  }

  it('is a no-op when no notifier is configured', () => {
    process.env['SLACK_NOTIFICATION_WEBHOOK_URL'] = 'https://hooks.example.com/slack'
    process.env['EMAIL_NOTIFICATION_WEBHOOK_URL'] = 'https://hooks.example.com/email'
    expect(() => registerEnvNotificationChannels(makeConfig(undefined))).not.toThrow()
  })

  it('registers Slack channel only when SLACK_NOTIFICATION_WEBHOOK_URL is set', () => {
    const addChannel = vi.fn()
    const notifier = { addChannel } as unknown as Notifier
    process.env['SLACK_NOTIFICATION_WEBHOOK_URL'] = 'https://hooks.example.com/slack'

    registerEnvNotificationChannels(makeConfig(notifier))
    expect(addChannel).toHaveBeenCalledTimes(1)
    expect(addChannel.mock.calls[0]?.[0]?.constructor?.name).toBe('SlackNotificationChannel')
  })

  it('registers email webhook channel when EMAIL_NOTIFICATION_WEBHOOK_URL is set', () => {
    const addChannel = vi.fn()
    const notifier = { addChannel } as unknown as Notifier
    process.env['EMAIL_NOTIFICATION_WEBHOOK_URL'] = 'https://hooks.example.com/email'
    process.env['EMAIL_NOTIFICATION_WEBHOOK_SECRET'] = 's3cret'

    registerEnvNotificationChannels(makeConfig(notifier))
    expect(addChannel).toHaveBeenCalledTimes(1)
    expect(addChannel.mock.calls[0]?.[0]?.constructor?.name).toBe('EmailWebhookNotificationChannel')
  })

  it('registers both Slack and Email when both env vars are set', () => {
    const addChannel = vi.fn()
    const notifier = { addChannel } as unknown as Notifier
    process.env['SLACK_NOTIFICATION_WEBHOOK_URL'] = 'https://hooks.example.com/slack'
    process.env['EMAIL_NOTIFICATION_WEBHOOK_URL'] = 'https://hooks.example.com/email'

    registerEnvNotificationChannels(makeConfig(notifier))
    expect(addChannel).toHaveBeenCalledTimes(2)
  })

  it('does nothing when neither env var is set', () => {
    const addChannel = vi.fn()
    const notifier = { addChannel } as unknown as Notifier

    registerEnvNotificationChannels(makeConfig(notifier))
    expect(addChannel).not.toHaveBeenCalled()
  })
})
