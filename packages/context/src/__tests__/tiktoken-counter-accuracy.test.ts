import { createRequire } from 'node:module'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { TiktokenCounter, __internals } from '../tiktoken-counter.js'

/**
 * Regression coverage for DZUPAGENT-AGENT-C-01.
 *
 * `TiktokenCounter` used to call the *wasm* `tiktoken` method names
 * (`encoding_for_model` / `get_encoding`) on `js-tiktoken`, whose API is
 * `encodingForModel` / `getEncoding`. Both were `undefined`, every call threw
 * into the bare `catch`, and 100% of token counts silently degraded to the
 * `Math.ceil(text.length / 4)` heuristic — indistinguishable from
 * `CharEstimateCounter`.
 *
 * The pre-existing suite (`tiktoken-counter.test.ts`) only asserted `> 0` and
 * a chars/4 upper bound, so it passed under total fallback. These tests assert
 * the counter is *not* returning the heuristic, and that model-id routing
 * picks the right vocabulary.
 *
 * Parity note: `packages/core/src/llm/tokenizer.ts` (`TiktokenTokenizer`) is a
 * sibling implementation over the same dependency. Rather than take a new
 * cross-package dependency from `@dzupagent/context` on `@dzupagent/core`,
 * parity is asserted against the shared oracle both implementations must
 * agree with: `js-tiktoken`'s own encoder output.
 */

const require_ = createRequire(import.meta.url)

type JsTiktoken = {
  getEncoding: (name: string) => { encode(text: string): number[] }
  encodingForModel: (model: string) => { encode(text: string): number[] }
}

function loadJsTiktoken(): JsTiktoken | null {
  try {
    return require_('js-tiktoken') as JsTiktoken
  } catch {
    return null
  }
}

/**
 * 400 words of ordinary English prose. Checked-in expected counts below are
 * derived from `js-tiktoken`'s `o200k_base` / `cl100k_base` vocabularies and
 * are stable across patch releases of the dependency.
 */
const SENTENCES = [
  'The quick brown fox jumps over the lazy dog near the riverbank.',
  'Token counting matters because context windows are a finite budget.',
  'A tokenizer maps text into integers drawn from a fixed vocabulary.',
  'English prose averages roughly four characters for every single token.',
  'Estimating with a simple divide by four rule is cheap but wrong.',
  'Accurate counts let an agent decide when to compress its history.',
  'When the estimate drifts the eviction policy trims the wrong messages.',
  'Careful measurement is the difference between a working budget and a guess.',
]

function buildFixture(wordCount: number): string {
  const words: string[] = []
  let i = 0
  while (words.length < wordCount) {
    words.push(...(SENTENCES[i % SENTENCES.length] ?? '').split(' '))
    i++
  }
  return words.slice(0, wordCount).join(' ')
}

const FIXTURE_400_WORDS = buildFixture(400)

/** `o200k_base` count for FIXTURE_400_WORDS (gpt-4o family). */
const EXPECTED_O200K = 459
/** `cl100k_base` count for FIXTURE_400_WORDS (gpt-4 / gpt-3.5 family). */
const EXPECTED_CL100K = 462

/**
 * Building a BPE encoder parses a multi-megabyte rank table. That is a
 * one-off cost per encoding (the counter caches encoders), but it is slow
 * enough on a loaded CI box to blow the 30s default, so warm both tables up
 * front and give the counting tests headroom.
 */
const SLOW = 240_000

describe('TiktokenCounter — real tokenization (DZUPAGENT-AGENT-C-01)', () => {
  beforeAll(() => {
    const mod = loadJsTiktoken()
    if (mod) {
      mod.getEncoding('o200k_base')
      mod.getEncoding('cl100k_base')
    }
  }, SLOW)

  beforeEach(() => {
    // Resets the optional-module lookups only. The encoder cache is keyed by
    // encoding name and rebuilding it per test costs seconds, so it is
    // deliberately preserved.
    __internals.resetCache()
  })

  it('has js-tiktoken available in this workspace', () => {
    // If this fails the remaining assertions are vacuous, so assert it loudly
    // rather than skipping silently the way the production code must.
    expect(loadJsTiktoken()).not.toBeNull()
  })

  it('routes gpt-4o and newer OpenAI ids to o200k_base', () => {
    expect(__internals.resolveEncodingName('gpt-4o')).toBe('o200k_base')
    expect(__internals.resolveEncodingName('gpt-4o-mini')).toBe('o200k_base')
    expect(__internals.resolveEncodingName('gpt-5')).toBe('o200k_base')
    expect(__internals.resolveEncodingName('gpt-5.1-codex')).toBe('o200k_base')
    expect(__internals.resolveEncodingName('o1-preview')).toBe('o200k_base')
    expect(__internals.resolveEncodingName('o3-mini')).toBe('o200k_base')
    expect(__internals.resolveEncodingName('o4-mini')).toBe('o200k_base')
    expect(__internals.resolveEncodingName('openai/gpt-4o')).toBe('o200k_base')
  })

  it('keeps cl100k_base for older GPT ids, unknown ids and no model', () => {
    expect(__internals.resolveEncodingName('gpt-4')).toBe('cl100k_base')
    expect(__internals.resolveEncodingName('gpt-4-turbo')).toBe('cl100k_base')
    expect(__internals.resolveEncodingName('gpt-3.5-turbo')).toBe('cl100k_base')
    expect(__internals.resolveEncodingName('some-future-model-v9')).toBe('cl100k_base')
    expect(__internals.resolveEncodingName(undefined)).toBe('cl100k_base')
  })

  it('is not silently returning the chars/4 heuristic for gpt-4o', () => {
    const counter = new TiktokenCounter()
    const actual = counter.count(FIXTURE_400_WORDS, 'gpt-4o')
    const heuristic = Math.ceil(FIXTURE_400_WORDS.length / 4)

    // Checked-in expected count (±2 tolerance for vocabulary patch drift).
    expect(actual).toBeGreaterThanOrEqual(EXPECTED_O200K - 2)
    expect(actual).toBeLessThanOrEqual(EXPECTED_O200K + 2)

    // ...and materially different from the heuristic it used to return.
    const drift = Math.abs(actual - heuristic) / heuristic
    expect(drift).toBeGreaterThan(0.05)
    expect(actual).not.toBe(heuristic)
  }, SLOW)

  it('produces the cl100k_base count for gpt-4', () => {
    const counter = new TiktokenCounter()
    const actual = counter.count(FIXTURE_400_WORDS, 'gpt-4')
    expect(actual).toBeGreaterThanOrEqual(EXPECTED_CL100K - 2)
    expect(actual).toBeLessThanOrEqual(EXPECTED_CL100K + 2)
  }, SLOW)

  it('matches the js-tiktoken oracle exactly (parity with core tokenizer)', () => {
    const mod = loadJsTiktoken()
    if (!mod) throw new Error('js-tiktoken unavailable')
    const counter = new TiktokenCounter()

    expect(counter.count(FIXTURE_400_WORDS, 'gpt-4o'))
      .toBe(mod.getEncoding('o200k_base').encode(FIXTURE_400_WORDS).length)
    expect(counter.count(FIXTURE_400_WORDS, 'gpt-4o'))
      .toBe(mod.encodingForModel('gpt-4o').encode(FIXTURE_400_WORDS).length)
    expect(counter.count(FIXTURE_400_WORDS, 'gpt-4'))
      .toBe(mod.getEncoding('cl100k_base').encode(FIXTURE_400_WORDS).length)
  }, SLOW)

  it('distinguishes token-dense from token-sparse text', () => {
    const counter = new TiktokenCounter()
    // The heuristic returns the same value for both (identical char length);
    // a real tokenizer does not.
    const prose = 'the the the the the the the the '.repeat(8)
    const dense = 'qx7@zv!kd9#pw2$mt4%hb6^rn8&cy0*lf'.repeat(8).slice(0, prose.length)
    expect(prose.length).toBe(dense.length)
    expect(Math.ceil(prose.length / 4)).toBe(Math.ceil(dense.length / 4))
    expect(counter.count(prose, 'gpt-4o')).not.toBe(counter.count(dense, 'gpt-4o'))
  }, SLOW)

  it('does not stall on a multi-kilobyte whitespace-free run', () => {
    // js-tiktoken's byte-pair merge loop is quadratic in the length of a
    // single "word". A 50 KB unbroken run (base64 blob, minified bundle,
    // long hash) would take minutes and block the event loop, so runs over
    // the cap are estimated instead. Bounded runtime is the assertion.
    const counter = new TiktokenCounter()
    const blob = 'x'.repeat(50_000)
    const started = Date.now()
    const n = counter.count(blob, 'gpt-4o')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(n).toBe(Math.ceil(blob.length / 4))
  }, SLOW)

  it('applies the same guard on the Claude branch', () => {
    // `@anthropic-ai/tokenizer` (when resolvable) is quadratic per word too —
    // measured 38.6 s unguarded for this input against 2 ms on the
    // js-tiktoken branch. The guard has to cover both backends.
    const counter = new TiktokenCounter()
    const blob = 'x'.repeat(50_000)
    const started = Date.now()
    const n = counter.count(blob, 'claude-3-5-sonnet-20241022')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(n).toBe(Math.ceil(blob.length / 4))
  }, SLOW)

  it('still tokenizes the prose around an over-long run exactly', () => {
    const mod = loadJsTiktoken()
    if (!mod) throw new Error('js-tiktoken unavailable')
    const counter = new TiktokenCounter()
    const blob = 'y'.repeat(3000)
    const text = `before the blob ${blob} after the blob`
    const enc = mod.getEncoding('o200k_base')
    const expected = enc.encode('before the blob ').length
      + Math.ceil(blob.length / 4)
      + enc.encode(' after the blob').length
    expect(counter.count(text, 'gpt-4o')).toBe(expected)
  }, SLOW)
})
