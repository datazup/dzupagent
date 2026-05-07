import type { AdapterProviderId, AgentEvent } from '../types.js'
import type { RecoveryCancelledResult } from './recovery-types.js'

export function createCancelledRecoveryResult(
  strategy: 'abort',
  providerId: AdapterProviderId | undefined,
  totalAttempts: number,
  totalDurationMs: number,
  error: string,
): RecoveryCancelledResult {
  return {
    success: false,
    cancelled: true,
    strategy,
    providerId,
    totalAttempts,
    totalDurationMs,
    error,
  }
}

export function createRecoveryCancelledEvent(
  providerId: AdapterProviderId | undefined,
  totalAttempts: number,
  totalDurationMs: number,
  error: string,
): AgentEvent {
  return {
    type: 'recovery:cancelled',
    providerId: providerId ?? ('unknown' as AdapterProviderId),
    strategy: 'abort',
    error,
    totalAttempts,
    totalDurationMs,
    timestamp: Date.now(),
  }
}
