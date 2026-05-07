import { fetchWithOutboundUrlPolicy, validateOutboundUrl, type OutboundUrlSecurityPolicy } from '@dzupagent/core/security'
import type { A2ATask, A2ATaskPushConfig } from './a2a-types.js'

export interface A2APushNotificationOptions {
  urlPolicy?: OutboundUrlSecurityPolicy | undefined
  fetchImpl?: typeof fetch | undefined
}

export interface A2APushNotificationPayload {
  id: string
  state: A2ATask['state']
  agentName: string
  createdAt: string
  updatedAt: string
  output?: unknown
  error?: string
  metadata?: Record<string, unknown>
}

export type A2APushNotificationPublicConfig = Omit<A2ATaskPushConfig, 'token'>

export async function assertA2APushCallbackUrlAllowed(
  url: string,
  policy?: OutboundUrlSecurityPolicy,
): Promise<void> {
  const result = await validateOutboundUrl(url, policy)
  if (!result.ok) {
    throw new Error(`A2A push callback URL rejected: ${result.reason}`)
  }
}

export function redactA2APushConfig(
  config: A2ATaskPushConfig | undefined,
): A2APushNotificationPublicConfig | undefined {
  if (!config) return undefined
  const { token: _token, ...publicConfig } = config
  return publicConfig
}

export function redactA2ATaskPushConfig(task: A2ATask): A2ATask {
  if (!task.pushNotificationConfig?.token) return task
  return {
    ...task,
    pushNotificationConfig: redactA2APushConfig(task.pushNotificationConfig),
  }
}

export function buildA2APushNotificationPayload(task: A2ATask): A2APushNotificationPayload {
  const payload: A2APushNotificationPayload = {
    id: task.id,
    state: task.state,
    agentName: task.agentName,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }

  if (task.output !== undefined) payload.output = task.output
  if (task.error !== undefined) payload.error = task.error
  if (task.metadata !== undefined) payload.metadata = task.metadata

  return payload
}

export async function deliverA2APushNotification(
  task: A2ATask,
  options: A2APushNotificationOptions = {},
): Promise<void> {
  const config = task.pushNotificationConfig
  if (!config?.url) return

  await assertA2APushCallbackUrlAllowed(config.url, options.urlPolicy)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.token) {
    headers['Authorization'] = `Bearer ${config.token}`
  }

  await fetchWithOutboundUrlPolicy(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildA2APushNotificationPayload(task)),
    signal: AbortSignal.timeout(5000),
  }, {
    policy: options.urlPolicy,
    fetchImpl: options.fetchImpl,
  })
}
