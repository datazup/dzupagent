import { it, expect, vi } from 'vitest'
import { WebhookConnector, type WebhookEvent } from '../webhook/webhook-connector.js'
const event: WebhookEvent = { id: 'e', type: 'change', payload: {}, headers: {} }
it('retries only failed handlers and surfaces transient failure', async () => {
  const connector = new WebhookConnector()
  const success = vi.fn()
  const retry = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined)
  connector.on('change', success).on('change', retry)
  await expect(connector.processOnce(event)).rejects.toThrow('Webhook delivery failed')
  expect(await connector.processOnce(event)).toBe(true)
  expect(await connector.processOnce(event)).toBe(false)
  expect(success).toHaveBeenCalledOnce()
  expect(retry).toHaveBeenCalledTimes(2)
})
it('shares concurrent delivery and evicts completed IDs at the retention limit', async () => {
  const connector = new WebhookConnector({ maxProcessedEvents: 1 })
  const handler = vi.fn()
  connector.on('change', handler)
  expect(await Promise.all([connector.processOnce(event), connector.processOnce(event)])).toEqual([true, false])
  await connector.processOnce({ ...event, id: 'second' })
  expect(await connector.processOnce(event)).toBe(true)
  expect(handler).toHaveBeenCalledTimes(3)
})
