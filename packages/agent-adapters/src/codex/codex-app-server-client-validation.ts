import { isAbsolute } from 'node:path'

import { CodexAppServerClientError } from './codex-app-server-client-contracts.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

/** Outbound method names are allow-listed so a caller cannot smuggle a frame. */
export function boundedMethod(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_./-]+$/u.test(value)
}

export function validServerRequestId(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length > 0 && value.length <= 512)
    || (Number.isSafeInteger(value) && Number(value) >= 0)
}

export function assertInitializeResponse(value: unknown): void {
  if (!isRecord(value)
    || !boundedString(value['codexHome'], 4_096)
    || !isAbsolute(value['codexHome'])
    || !boundedString(value['platformFamily'], 256)
    || !boundedString(value['platformOs'], 256)
    || !boundedString(value['userAgent'], 1_024)) {
    throw new CodexAppServerClientError(
      'CODEX_APP_SERVER_INITIALIZE_INVALID',
      'Codex app-server returned an invalid initialize response',
    )
  }
}
