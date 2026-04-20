import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  classifyInteractionText,
  detectCliInteraction,
} from '../interaction/interaction-detector.js'
import { InteractionResolver } from '../interaction/interaction-resolver.js'
import type { InteractionPolicy } from '../types.js'

// ===========================================================================
// InteractionDetector
// ===========================================================================

describe('classifyInteractionText', () => {
  it('returns "permission" for permission-style questions', () => {
    expect(classifyInteractionText('Allow write access to /tmp/foo?')).toBe('permission')
    expect(classifyInteractionText('Grant execute permission?')).toBe('permission')
    expect(classifyInteractionText('May I delete this file?')).toBe('permission')
  })

  it('returns "confirmation" for confirmation-style questions', () => {
    expect(classifyInteractionText('Are you sure you want to proceed?')).toBe('confirmation')
    expect(classifyInteractionText('Ok to continue?')).toBe('confirmation')
    expect(classifyInteractionText('Please confirm the action?')).toBe('confirmation')
  })

  it('returns "clarification" for clarification-style questions', () => {
    expect(classifyInteractionText('Which option should I pick?')).toBe('clarification')
    expect(classifyInteractionText('What should I do next?')).toBe('clarification')
    expect(classifyInteractionText('Please specify the target directory?')).toBe('clarification')
  })

  it('returns "unknown" for plain statements without question marks', () => {
    expect(classifyInteractionText('Processing file.')).toBe('unknown')
    expect(classifyInteractionText('Done.')).toBe('unknown')
    expect(classifyInteractionText('')).toBe('unknown')
  })

  it('returns "unknown" for questions that do not match any known pattern', () => {
    expect(classifyInteractionText('Is it raining?')).toBe('unknown')
    expect(classifyInteractionText('Has the build finished?')).toBe('unknown')
  })
})

describe('detectCliInteraction', () => {
  it('returns question/kind for records with known interaction types', () => {
    for (const type of [
      'question',
      'permission_request',
      'confirm',
      'confirmation',
      'clarification',
      'user_input',
      'approval_request',
    ]) {
      const result = detectCliInteraction({
        type,
        message: 'Allow write access to /tmp/foo?',
      })
      expect(result).toEqual({
        question: 'Allow write access to /tmp/foo?',
        kind: 'permission',
      })
    }
  })

  it('returns null for records with known interaction type but no text fields', () => {
    expect(detectCliInteraction({ type: 'question' })).toBeNull()
    expect(detectCliInteraction({ type: 'permission_request', other: 42 })).toBeNull()
  })

  it('returns question/kind for records with type "message" and question-ending text', () => {
    const result = detectCliInteraction({
      type: 'message',
      text: 'Are you sure you want to proceed?',
    })
    expect(result).toEqual({
      question: 'Are you sure you want to proceed?',
      kind: 'confirmation',
    })
  })

  it('returns question/kind for records with no type and question-ending text', () => {
    const result = detectCliInteraction({
      message: 'Which option should I pick?',
    })
    expect(result).toEqual({
      question: 'Which option should I pick?',
      kind: 'clarification',
    })
  })

  it('returns null for records with type "message" and non-question text', () => {
    expect(
      detectCliInteraction({ type: 'message', text: 'Processing...' }),
    ).toBeNull()
    expect(
      detectCliInteraction({ type: 'message', text: 'Done.' }),
    ).toBeNull()
  })

  it('returns null for records with unrecognized type like "result"', () => {
    expect(
      detectCliInteraction({ type: 'result', text: 'Are you sure?' }),
    ).toBeNull()
    expect(
      detectCliInteraction({ type: 'status', message: 'Proceed?' }),
    ).toBeNull()
  })

  it('tries all known text field names', () => {
    const fields = ['message', 'text', 'question', 'prompt', 'content', 'body']
    for (const field of fields) {
      const record: Record<string, unknown> = {
        type: 'question',
        [field]: 'Allow write access?',
      }
      const result = detectCliInteraction(record)
      expect(result).toEqual({
        question: 'Allow write access?',
        kind: 'permission',
      })
    }
  })

  it('prefers "message" over other fields when multiple are present', () => {
    const result = detectCliInteraction({
      type: 'question',
      message: 'First?',
      text: 'Second?',
    })
    expect(result?.question).toBe('First?')
  })

  it('returns null for records with empty-string text values', () => {
    expect(
      detectCliInteraction({ type: 'question', message: '   ' }),
    ).toBeNull()
  })
})

// ===========================================================================
// InteractionResolver
// ===========================================================================

function makeReq(overrides: Partial<{ interactionId: string; question: string; kind: 'permission' | 'clarification' | 'confirmation' | 'unknown'; context: string }> = {}) {
  return {
    interactionId: overrides.interactionId ?? 'i-1',
    question: overrides.question ?? 'Allow write access?',
    kind: overrides.kind ?? ('permission' as const),
    context: overrides.context,
  }
}

describe('InteractionResolver — auto-approve mode', () => {
  it('returns { answer: "yes", resolvedBy: "auto-approve" } immediately', async () => {
    const resolver = new InteractionResolver({ mode: 'auto-approve' })
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'yes', resolvedBy: 'auto-approve' })
  })

  it('uses auto-approve as default policy', async () => {
    const resolver = new InteractionResolver()
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'yes', resolvedBy: 'auto-approve' })
  })
})

describe('InteractionResolver — auto-deny mode', () => {
  it('returns { answer: "no", resolvedBy: "auto-deny" } immediately', async () => {
    const resolver = new InteractionResolver({ mode: 'auto-deny' })
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'no', resolvedBy: 'auto-deny' })
  })
})

describe('InteractionResolver — default-answers mode', () => {
  it('returns configured answer when pattern matches', async () => {
    const policy: InteractionPolicy = {
      mode: 'default-answers',
      defaultAnswers: {
        patterns: [
          { pattern: 'write access', answer: 'yes' },
          { pattern: 'delete', answer: 'no' },
        ],
      },
    }
    const resolver = new InteractionResolver(policy)
    const result = await resolver.resolve(
      makeReq({ question: 'Allow write access to /tmp?' }),
    )
    expect(result).toEqual({ answer: 'yes', resolvedBy: 'default-answers' })
  })

  it('falls back to auto-deny when no pattern matches', async () => {
    const policy: InteractionPolicy = {
      mode: 'default-answers',
      defaultAnswers: {
        patterns: [{ pattern: 'nomatch', answer: 'yes' }],
      },
    }
    const resolver = new InteractionResolver(policy)
    const result = await resolver.resolve(makeReq({ question: 'Some other thing?' }))
    expect(result).toEqual({ answer: 'no', resolvedBy: 'auto-deny' })
  })

  it('skips malformed regex patterns without throwing and falls through', async () => {
    const policy: InteractionPolicy = {
      mode: 'default-answers',
      defaultAnswers: {
        patterns: [
          { pattern: '[unclosed(', answer: 'yes' }, // malformed
          { pattern: 'file', answer: 'maybe' },
        ],
      },
    }
    const resolver = new InteractionResolver(policy)
    const result = await resolver.resolve(makeReq({ question: 'Modify file?' }))
    expect(result).toEqual({ answer: 'maybe', resolvedBy: 'default-answers' })
  })

  it('falls through to deny when all patterns are malformed', async () => {
    const policy: InteractionPolicy = {
      mode: 'default-answers',
      defaultAnswers: {
        patterns: [{ pattern: '[unclosed(', answer: 'yes' }],
      },
    }
    const resolver = new InteractionResolver(policy)
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'no', resolvedBy: 'auto-deny' })
  })

  it('returns deny when patterns array is empty', async () => {
    const policy: InteractionPolicy = {
      mode: 'default-answers',
      defaultAnswers: { patterns: [] },
    }
    const resolver = new InteractionResolver(policy)
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'no', resolvedBy: 'auto-deny' })
  })

  it('returns deny when defaultAnswers config is missing', async () => {
    const policy: InteractionPolicy = { mode: 'default-answers' }
    const resolver = new InteractionResolver(policy)
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'no', resolvedBy: 'auto-deny' })
  })

  it('uses case-insensitive matching', async () => {
    const policy: InteractionPolicy = {
      mode: 'default-answers',
      defaultAnswers: {
        patterns: [{ pattern: 'WRITE', answer: 'yes' }],
      },
    }
    const resolver = new InteractionResolver(policy)
    const result = await resolver.resolve(makeReq({ question: 'allow write access?' }))
    expect(result).toEqual({ answer: 'yes', resolvedBy: 'default-answers' })
  })
})

describe('InteractionResolver — ask-caller mode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with caller answer when respond() is called before timeout', async () => {
    const resolver = new InteractionResolver({
      mode: 'ask-caller',
      askCaller: { timeoutMs: 5_000 },
    })
    const req = makeReq({ interactionId: 'ask-1' })
    const resultPromise = resolver.resolve(req)

    // Let the promise register its pending state
    await Promise.resolve()

    const ok = resolver.respond('ask-1', 'custom-answer')
    expect(ok).toBe(true)

    const result = await resultPromise
    expect(result).toEqual({ answer: 'custom-answer', resolvedBy: 'caller' })
  })

  it('returns false from respond() for unknown interaction IDs', () => {
    const resolver = new InteractionResolver({ mode: 'ask-caller' })
    const ok = resolver.respond('does-not-exist', 'yes')
    expect(ok).toBe(false)
  })

  it('returns true from respond() for known interaction IDs', async () => {
    const resolver = new InteractionResolver({ mode: 'ask-caller' })
    const req = makeReq({ interactionId: 'ask-known' })
    const resultPromise = resolver.resolve(req)
    await Promise.resolve()

    expect(resolver.respond('ask-known', 'yes')).toBe(true)
    await resultPromise
  })

  it('resolves with timeout-fallback "no" on timeout (default)', async () => {
    const resolver = new InteractionResolver({
      mode: 'ask-caller',
      askCaller: { timeoutMs: 1_000 },
    })
    const resultPromise = resolver.resolve(makeReq({ interactionId: 'timeout-1' }))

    await vi.advanceTimersByTimeAsync(1_000)
    const result = await resultPromise
    expect(result).toEqual({ answer: 'no', resolvedBy: 'timeout-fallback' })
  })

  it('resolves with timeout-fallback "yes" when timeoutFallback is auto-approve', async () => {
    const resolver = new InteractionResolver({
      mode: 'ask-caller',
      askCaller: { timeoutMs: 500, timeoutFallback: 'auto-approve' },
    })
    const resultPromise = resolver.resolve(makeReq({ interactionId: 'timeout-2' }))

    await vi.advanceTimersByTimeAsync(500)
    const result = await resultPromise
    expect(result).toEqual({ answer: 'yes', resolvedBy: 'timeout-fallback' })
  })

  it('honors the configured timeoutMs value', async () => {
    const resolver = new InteractionResolver({
      mode: 'ask-caller',
      askCaller: { timeoutMs: 30_000 },
    })
    const resultPromise = resolver.resolve(makeReq({ interactionId: 'timeout-3' }))
    let resolved = false
    resultPromise.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(29_000)
    await Promise.resolve()
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    await resultPromise
    expect(resolved).toBe(true)
  })

  it('uses default 60s timeout when none configured', async () => {
    const resolver = new InteractionResolver({ mode: 'ask-caller' })
    const resultPromise = resolver.resolve(makeReq({ interactionId: 'timeout-4' }))

    await vi.advanceTimersByTimeAsync(60_000)
    const result = await resultPromise
    expect(result.resolvedBy).toBe('timeout-fallback')
  })
})

describe('InteractionResolver — ai-autonomous mode', () => {
  const savedAnthropicKey = process.env['ANTHROPIC_API_KEY']
  const savedDzupKey = process.env['DZUPAGENT_LLM_API_KEY']

  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key'
    delete process.env['DZUPAGENT_LLM_API_KEY']
  })

  afterEach(() => {
    if (savedAnthropicKey !== undefined) {
      process.env['ANTHROPIC_API_KEY'] = savedAnthropicKey
    } else {
      delete process.env['ANTHROPIC_API_KEY']
    }
    if (savedDzupKey !== undefined) {
      process.env['DZUPAGENT_LLM_API_KEY'] = savedDzupKey
    } else {
      delete process.env['DZUPAGENT_LLM_API_KEY']
    }
    vi.unstubAllGlobals()
  })

  it('returns { answer: "yes", resolvedBy: "ai-autonomous" } when LLM replies "yes"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'yes' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const resolver = new InteractionResolver({ mode: 'ai-autonomous' })
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'yes', resolvedBy: 'ai-autonomous' })
  })

  it('normalizes "yeah" to "yes"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'yeah' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const resolver = new InteractionResolver({ mode: 'ai-autonomous' })
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'yes', resolvedBy: 'ai-autonomous' })
  })

  it('returns "no" when LLM replies "no"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'no' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const resolver = new InteractionResolver({ mode: 'ai-autonomous' })
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'no', resolvedBy: 'ai-autonomous' })
  })

  it('falls back to auto-deny on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const resolver = new InteractionResolver({ mode: 'ai-autonomous' })
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'no', resolvedBy: 'auto-deny' })
  })

  it('falls back to auto-deny on non-ok HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('server error', { status: 500, statusText: 'Internal Server Error' }),
      ),
    )
    const resolver = new InteractionResolver({ mode: 'ai-autonomous' })
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'no', resolvedBy: 'auto-deny' })
  })

  it('falls back to auto-deny when no API key is available', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['DZUPAGENT_LLM_API_KEY']
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const resolver = new InteractionResolver({ mode: 'ai-autonomous' })
    const result = await resolver.resolve(makeReq())
    expect(result).toEqual({ answer: 'no', resolvedBy: 'auto-deny' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('prefers DZUPAGENT_LLM_API_KEY over ANTHROPIC_API_KEY', async () => {
    process.env['DZUPAGENT_LLM_API_KEY'] = 'dzup-key'
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-key'
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'yes' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchSpy)

    const resolver = new InteractionResolver({ mode: 'ai-autonomous' })
    await resolver.resolve(makeReq())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('dzup-key')
  })

  it('includes context in the system prompt when provided', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'yes' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchSpy)

    const resolver = new InteractionResolver({ mode: 'ai-autonomous' })
    await resolver.resolve(makeReq({ context: 'Running in sandbox mode' }))

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const parsed = JSON.parse(init.body as string) as { system: string }
    expect(parsed.system).toContain('Running in sandbox mode')
  })

  it('uses configured model when provided', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'yes' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchSpy)

    const resolver = new InteractionResolver({
      mode: 'ai-autonomous',
      aiAutonomous: { model: 'claude-sonnet-4-5' },
    })
    await resolver.resolve(makeReq())

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const parsed = JSON.parse(init.body as string) as { model: string }
    expect(parsed.model).toBe('claude-sonnet-4-5')
  })
})

describe('InteractionResolver — dispose()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels all pending ask-caller interactions with timeout-fallback answer', async () => {
    const resolver = new InteractionResolver({
      mode: 'ask-caller',
      askCaller: { timeoutMs: 10_000 },
    })

    const p1 = resolver.resolve(makeReq({ interactionId: 'd-1' }))
    const p2 = resolver.resolve(makeReq({ interactionId: 'd-2' }))

    await Promise.resolve()
    resolver.dispose()

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual({ answer: 'no', resolvedBy: 'timeout-fallback' })
    expect(r2).toEqual({ answer: 'no', resolvedBy: 'timeout-fallback' })
  })

  it('honors timeoutFallback "auto-approve" on dispose', async () => {
    const resolver = new InteractionResolver({
      mode: 'ask-caller',
      askCaller: { timeoutMs: 10_000, timeoutFallback: 'auto-approve' },
    })

    const p = resolver.resolve(makeReq({ interactionId: 'd-3' }))
    await Promise.resolve()
    resolver.dispose()

    const r = await p
    expect(r).toEqual({ answer: 'yes', resolvedBy: 'timeout-fallback' })
  })

  it('has no pending interactions after dispose', async () => {
    const resolver = new InteractionResolver({
      mode: 'ask-caller',
      askCaller: { timeoutMs: 10_000 },
    })

    const p = resolver.resolve(makeReq({ interactionId: 'd-4' }))
    await Promise.resolve()
    resolver.dispose()
    await p

    // Responding after dispose should return false because pending map is cleared
    expect(resolver.respond('d-4', 'yes')).toBe(false)
  })
})
