import { describe, expect, it } from 'vitest'
import {
  PROVIDER_QUOTA_WINDOW_MINUTES,
  assessProviderQuotaReading,
  validateProviderQuotaReading,
} from '@dzupagent/runtime-contracts'

import {
  CODEX_QUOTA_RPC_METHOD,
  createCodexQuotaProbe,
  normalizeCodexRateLimits,
  type CodexQuotaRpcClient,
} from '../codex/codex-quota-probe.js'

const T0 = Date.parse('2026-11-11T10:00:00.000Z')
const FIVE = PROVIDER_QUOTA_WINDOW_MINUTES.fiveHours
const SEVEN = PROVIDER_QUOTA_WINDOW_MINUTES.sevenDays
const resetSeconds = (offsetMs: number) => (T0 + offsetMs) / 1000

/** Fixture shaped like the generated app-server `GetAccountRateLimitsResponse`. */
function snapshot(limitId: string, primaryUsed: number, secondaryUsed: number) {
  return {
    limitId,
    limitName: 'Display name with spaces',
    normalModelSlug: null,
    primary: { usedPercent: primaryUsed, windowDurationMins: FIVE, resetsAt: resetSeconds(3_600_000) },
    secondary: { usedPercent: secondaryUsed, windowDurationMins: SEVEN, resetsAt: resetSeconds(86_400_000) },
    credits: { hasCredits: true, unlimited: false, balance: '12.00' },
    individualLimit: null,
    spendControlReached: false,
    planType: 'pro',
    rateLimitReachedType: null,
  }
}

const multiBucket = {
  ordinaryUsageAllowed: true,
  accountId: 'acct-private-identifier',
  rateLimits: snapshot('codex', 10, 20),
  rateLimitsByLimitId: {
    codex: snapshot('codex', 10, 20),
    codex_bengalfox: { ...snapshot('codex_bengalfox', 0, 55), normalModelSlug: 'gpt-5.3-codex-spark' },
  },
  rateLimitResetCredits: null,
  rateLimitUpsell: null,
}

class FakeClient implements CodexQuotaRpcClient {
  readonly methods: string[] = []
  readonly params: Readonly<Record<string, unknown>>[] = []
  closed = 0
  constructor(
    private readonly respond: (signal?: AbortSignal) => Promise<unknown>,
    private readonly closeImpl: () => Promise<void> = async () => undefined,
  ) {}

  request(method: string, params: Readonly<Record<string, unknown>>, options?: { readonly signal?: AbortSignal }): Promise<unknown> {
    this.methods.push(method)
    this.params.push(params)
    return this.respond(options?.signal)
  }

  async close(): Promise<void> {
    this.closed += 1
    await this.closeImpl()
  }
}

const never = (signal?: AbortSignal) => new Promise<unknown>((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(Object.assign(new Error('provider said: secret detail'), { code: 'CODEX_APP_SERVER_CANCELLED' })))
})

const both = { requiredWindowMinutes: [FIVE, SEVEN] }

describe('Codex quota normalization', () => {
  const context = { poolRef: 'acct-pool', observedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 300_000).toISOString() }

  it('keeps both windows and every bucket with identity and time', () => {
    const observations = normalizeCodexRateLimits(multiBucket, context)!
    expect(observations.map((entry) => entry.bucketRef)).toEqual(['codex', 'codex_bengalfox'])
    expect(observations[1]!.modelScope).toBe('gpt-5.3-codex-spark')
    expect(observations[0]!.windows).toEqual([
      { windowRef: 'primary', durationMinutes: FIVE, usedPercent: 10, resetsAt: new Date(T0 + 3_600_000).toISOString() },
      { windowRef: 'secondary', durationMinutes: SEVEN, usedPercent: 20, resetsAt: new Date(T0 + 86_400_000).toISOString() },
    ])
    for (const entry of observations) expect(entry).toMatchObject({ observedAt: context.observedAt, poolRef: 'acct-pool', source: CODEX_QUOTA_RPC_METHOD })
  })

  it('falls back to the single snapshot when the bucket map is absent or empty', () => {
    for (const map of [null, {}, undefined]) {
      const observations = normalizeCodexRateLimits({ rateLimits: snapshot('codex', 5, 6), rateLimitsByLimitId: map }, context)!
      expect(observations).toHaveLength(1)
      expect(observations[0]!.bucketRef).toBe('codex')
    }
  })

  it('identifies windows by duration and keeps independently missing fields', () => {
    const swapped = {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 70, windowDurationMins: SEVEN, resetsAt: null },
        secondary: { usedPercent: 0, windowDurationMins: null, resetsAt: resetSeconds(1000) },
      },
    }
    const [observation] = normalizeCodexRateLimits(swapped, context)!
    expect(observation!.windows).toEqual([
      { windowRef: 'primary', durationMinutes: SEVEN, usedPercent: 70, resetsAt: null },
      { windowRef: 'secondary', durationMinutes: null, usedPercent: 0, resetsAt: new Date(T0 + 1000).toISOString() },
    ])
    const noSecondary = normalizeCodexRateLimits({ rateLimits: { ...snapshot('codex', 1, 2), secondary: null } }, context)!
    expect(noSecondary[0]!.windows.map((window) => window.durationMinutes)).toEqual([FIVE])
    const malformed = normalizeCodexRateLimits({ rateLimits: { ...snapshot('codex', 1, 2), primary: { usedPercent: '1', windowDurationMins: FIVE } } }, context)!
    expect(malformed[0]!.windows[0]).toEqual({ windowRef: 'primary', durationMinutes: FIVE, usedPercent: null, resetsAt: null })
  })

  it('retains no raw payload, account identifier or free text', () => {
    const text = JSON.stringify(normalizeCodexRateLimits(multiBucket, context))
    for (const leaked of ['acct-private-identifier', 'Display name', 'balance', 'planType', 'credits', '12.00']) {
      expect(text).not.toContain(leaked)
    }
  })

  it('returns null for an unusable payload', () => {
    expect(normalizeCodexRateLimits(null, context)).toBeNull()
    expect(normalizeCodexRateLimits({ rateLimits: 'nope' }, context)).toBeNull()
  })
})

describe('Codex quota probe', () => {
  it('reads through a shared client with exactly one allowed RPC and leaves it open', async () => {
    const client = new FakeClient(async () => multiBucket)
    const probe = createCodexQuotaProbe({ client, poolRef: 'acct-pool', now: () => T0 })
    const reading = await probe.read()
    expect(reading.status).toBe('current')
    expect(validateProviderQuotaReading(reading)).toEqual([])
    expect(reading.observations).toHaveLength(2)
    expect(client.methods).toEqual([CODEX_QUOTA_RPC_METHOD])
    expect(client.closed).toBe(0)
    const assessed = assessProviderQuotaReading(reading, { ...both, now: new Date(T0 + 1000).toISOString() })
    expect(assessed.map((entry) => entry.state)).toEqual(['available', 'available', 'available', 'available'])
    expect(assessed[2]).toMatchObject({ bucketRef: 'codex_bengalfox', usedPercent: 0 })
  })

  it('never sends thread, turn, login, logout, credit or settings requests', async () => {
    const client = new FakeClient(async () => multiBucket)
    const probe = createCodexQuotaProbe({ client, poolRef: null, now: () => T0 })
    await probe.read()
    await probe.read()
    expect(client.methods).toEqual([CODEX_QUOTA_RPC_METHOD, CODEX_QUOTA_RPC_METHOD])
    expect(client.params).toEqual([{ excludeResetCreditDetails: true }, { excludeResetCreditDetails: true }])
    expect(client.methods.some((method) => /thread|turn|login|logout|credit|config|setting/i.test(method))).toBe(false)
  })

  it('closes an owned client after success and after failure', async () => {
    const ok = new FakeClient(async () => multiBucket)
    const okReading = await createCodexQuotaProbe({ connect: async () => ok, poolRef: null, now: () => T0 }).read()
    expect(okReading.status).toBe('current')
    expect(ok.closed).toBe(1)

    const rpcFailure = new FakeClient(async () => { throw Object.assign(new Error('auth details from provider'), { code: 'CODEX_APP_SERVER_REQUEST_FAILED' }) })
    const failed = await createCodexQuotaProbe({ connect: async () => rpcFailure, poolRef: null, now: () => T0 }).read()
    expect(failed).toMatchObject({ status: 'failed', reason: 'rpc-error', observations: [] })
    expect(JSON.stringify(failed)).not.toContain('auth details')
    expect(rpcFailure.closed).toBe(1)
  })

  it('ends a hung request at the deadline with a sanitized timeout and reaps the owned client', async () => {
    const hung = new FakeClient(never)
    const started = performance.now()
    const reading = await createCodexQuotaProbe({ connect: async () => hung, poolRef: null, now: () => T0, timeoutMs: 40 }).read()
    expect(performance.now() - started).toBeLessThan(2000)
    expect(reading).toMatchObject({ status: 'failed', reason: 'timeout' })
    expect(JSON.stringify(reading)).not.toContain('secret detail')
    expect(hung.closed).toBe(1)
  })

  it('ends a hung connect at the deadline and closes the client if it arrives late', async () => {
    let deliver: ((client: CodexQuotaRpcClient) => void) | undefined
    const late = new FakeClient(async () => multiBucket)
    const reading = await createCodexQuotaProbe({
      connect: () => new Promise<CodexQuotaRpcClient>((resolve) => { deliver = resolve }),
      poolRef: null,
      now: () => T0,
      timeoutMs: 30,
    }).read()
    expect(reading).toMatchObject({ status: 'failed', reason: 'timeout' })
    deliver?.(late)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(late.closed).toBe(1)
    expect(late.methods).toEqual([])
  })

  it('honours cancellation before and during the read', async () => {
    const before = new AbortController()
    before.abort()
    const unused = new FakeClient(async () => multiBucket)
    const early = await createCodexQuotaProbe({ client: unused, poolRef: null, now: () => T0 }).read({ signal: before.signal })
    expect(early).toMatchObject({ status: 'failed', reason: 'cancelled' })
    expect(unused.methods).toEqual([])

    const during = new AbortController()
    const hung = new FakeClient(never)
    const pending = createCodexQuotaProbe({ connect: async () => hung, poolRef: null, now: () => T0, timeoutMs: 5000 }).read({ signal: during.signal })
    setTimeout(() => during.abort(), 10)
    expect(await pending).toMatchObject({ status: 'failed', reason: 'cancelled' })
    expect(hung.closed).toBe(1)
  })

  it('reports a failed or hung cleanup boundedly', async () => {
    const throwing = new FakeClient(async () => multiBucket, async () => { throw new Error('kill failed: pid detail') })
    const failed = await createCodexQuotaProbe({ connect: async () => throwing, poolRef: null, now: () => T0 }).read()
    expect(failed).toMatchObject({ status: 'failed', reason: 'cleanup-failed' })
    expect(JSON.stringify(failed)).not.toContain('pid detail')

    const hangingClose = new FakeClient(async () => multiBucket, () => new Promise<void>(() => undefined))
    const started = performance.now()
    const hung = await createCodexQuotaProbe({ connect: async () => hangingClose, poolRef: null, now: () => T0, timeoutMs: 20, cleanupGraceMs: 30 }).read()
    expect(performance.now() - started).toBeLessThan(2000)
    expect(hung).toMatchObject({ status: 'failed', reason: 'cleanup-failed' })
  })

  it('maps transport and schema failures to fixed reasons', async () => {
    const died = new FakeClient(async () => { throw Object.assign(new Error('stderr: something'), { code: 'CODEX_APP_SERVER_PROCESS_DIED' }) })
    expect(await createCodexQuotaProbe({ client: died, poolRef: null, now: () => T0 }).read()).toMatchObject({ reason: 'transport-failed' })
    const plain = new FakeClient(async () => { throw new Error('unexpected') })
    expect(await createCodexQuotaProbe({ client: plain, poolRef: null, now: () => T0 }).read()).toMatchObject({ reason: 'transport-failed' })
    const connectFails = createCodexQuotaProbe({ connect: async () => { throw Object.assign(new Error('x'), { code: 'CODEX_APP_SERVER_TIMEOUT' }) }, poolRef: null, now: () => T0 })
    expect(await connectFails.read()).toMatchObject({ reason: 'timeout' })
    const weird = new FakeClient(async () => ({ unexpected: true }))
    const schema = await createCodexQuotaProbe({ client: weird, poolRef: null, now: () => T0 }).read()
    expect(schema).toMatchObject({ status: 'failed', reason: 'schema-invalid' })
    expect(assessProviderQuotaReading(schema, { ...both, now: new Date(T0).toISOString() }).map((entry) => [entry.state, entry.reason])).toEqual([['unknown', 'schema-invalid'], ['unknown', 'schema-invalid']])
  })

  it('reports exhausted buckets as exhausted, not available', async () => {
    const client = new FakeClient(async () => ({ rateLimits: snapshot('codex', 100, 30) }))
    const reading = await createCodexQuotaProbe({ client, poolRef: null, now: () => T0 }).read()
    const [five, seven] = assessProviderQuotaReading(reading, { ...both, now: new Date(T0).toISOString() })
    expect(five).toMatchObject({ state: 'exhausted', usedPercent: 100 })
    expect(seven).toMatchObject({ state: 'available', usedPercent: 30 })
  })

  it('validates its configuration', () => {
    const client = new FakeClient(async () => multiBucket)
    expect(() => createCodexQuotaProbe({ client, poolRef: 'has spaces' })).toThrow(TypeError)
    expect(() => createCodexQuotaProbe({ poolRef: null } as never)).toThrow(TypeError)
    expect(() => createCodexQuotaProbe({ client, connect: async () => client, poolRef: null } as never)).toThrow(TypeError)
  })
})
