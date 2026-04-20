import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VirtualFS } from '../../vfs/virtual-fs.js'
import { CopyOnWriteVFS } from '../../vfs/cow-vfs.js'
import {
  sample,
  selectBest,
  commitBest,
  sampleAndCommitBest,
} from '../../vfs/parallel-sampling.js'
import type { SampleResult } from '../../vfs/vfs-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVFS(initial?: Record<string, string>): VirtualFS {
  return new VirtualFS(
    initial ?? {
      'src/index.ts': 'export const version = "1.0.0"',
      'src/utils.ts': 'export function noop() {}',
    },
  )
}

/** Build a SampleResult without error. */
function okResult<T>(forkIndex: number, result: T, durationMs = 5): SampleResult<T> {
  return { forkIndex, result, index: forkIndex, durationMs }
}

/** Build a SampleResult with an error. */
function errResult<T>(forkIndex: number, error: string, durationMs = 5): SampleResult<T> {
  return {
    forkIndex,
    result: undefined as unknown as T,
    index: forkIndex,
    durationMs,
    error,
  }
}

// ---------------------------------------------------------------------------
// sample()
// ---------------------------------------------------------------------------

describe('sample()', () => {
  let root: VirtualFS

  beforeEach(() => {
    root = makeVFS()
  })

  it('count=1 runs exactly one fork', async () => {
    const called: number[] = []
    const results = await sample(root, 1, async (_fork, index) => {
      called.push(index)
      return index
    })

    expect(called).toHaveLength(1)
    expect(called[0]).toBe(0)
    expect(results).toHaveLength(1)
  })

  it('count=N runs N forks', async () => {
    const called: number[] = []
    const results = await sample(root, 5, async (_fork, index) => {
      called.push(index)
      return index
    })

    expect(called).toHaveLength(5)
    expect(results).toHaveLength(5)
  })

  it('each fork receives its correct index', async () => {
    const receivedIndices: number[] = []
    await sample(root, 4, async (_fork, index) => {
      receivedIndices.push(index)
      return index
    })

    // The indices may arrive in any order due to concurrency, so sort before comparing.
    expect(receivedIndices.sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
  })

  it('successful result has forkIndex, index, result, durationMs — and no error field', async () => {
    const results = await sample(root, 1, async (_fork, _index) => {
      return 'hello'
    })

    const r = results[0]!
    expect(r.forkIndex).toBe(0)
    expect(r.index).toBe(0)
    expect(r.result).toBe('hello')
    expect(r.durationMs).toBeTypeOf('number')
    expect(r.error).toBeUndefined()
  })

  it('forkIndex matches index for every successful result', async () => {
    const results = await sample(root, 3, async (_fork, index) => index * 10)

    for (const r of results) {
      expect(r.forkIndex).toBe(r.index)
    }
  })

  it('failed fn is captured: error field set, result is undefined-like', async () => {
    const results = await sample(root, 1, async () => {
      throw new Error('boom')
    })

    const r = results[0]!
    expect(r.error).toBe('boom')
    // The source sets result to `undefined as unknown as T` on error
    expect(r.result).toBeUndefined()
    expect(r.forkIndex).toBe(0)
    expect(r.durationMs).toBeTypeOf('number')
  })

  it('non-Error thrown values are stringified', async () => {
    const results = await sample(root, 1, async () => {
      throw 'string-error' // eslint-disable-line @typescript-eslint/only-throw-error
    })

    expect(results[0]!.error).toBe('string-error')
  })

  it('count=0 throws with message about valid range', async () => {
    await expect(sample(root, 0, async () => 'x')).rejects.toThrow(
      /between 1 and 10/,
    )
  })

  it('count=11 throws with message about valid range', async () => {
    await expect(sample(root, 11, async () => 'x')).rejects.toThrow(
      /between 1 and 10/,
    )
  })

  it('count=10 works (upper boundary)', async () => {
    const results = await sample(root, 10, async (_fork, index) => index)
    expect(results).toHaveLength(10)
    expect(results.every(r => r.error === undefined)).toBe(true)
  })

  it('count=1 works (lower boundary)', async () => {
    const results = await sample(root, 1, async (_fork, index) => index)
    expect(results).toHaveLength(1)
    expect(results[0]!.error).toBeUndefined()
  })

  it('mixed success/failure: correct forkIndex on both kinds', async () => {
    const results = await sample(root, 4, async (_fork, index) => {
      if (index % 2 === 1) throw new Error(`fail-${index}`)
      return `ok-${index}`
    })

    expect(results).toHaveLength(4)

    const sorted = [...results].sort((a, b) => a.forkIndex - b.forkIndex)
    expect(sorted[0]!.forkIndex).toBe(0)
    expect(sorted[0]!.error).toBeUndefined()
    expect(sorted[0]!.result).toBe('ok-0')

    expect(sorted[1]!.forkIndex).toBe(1)
    expect(sorted[1]!.error).toBe('fail-1')

    expect(sorted[2]!.forkIndex).toBe(2)
    expect(sorted[2]!.error).toBeUndefined()
    expect(sorted[2]!.result).toBe('ok-2')

    expect(sorted[3]!.forkIndex).toBe(3)
    expect(sorted[3]!.error).toBe('fail-3')
  })

  it('durationMs is a non-negative number for all results', async () => {
    const results = await sample(root, 3, async (_fork, index) => {
      if (index === 1) throw new Error('fail')
      return index
    })

    for (const r of results) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(r.durationMs)).toBe(true)
    }
  })

  it('each fork is an independent CopyOnWriteVFS — writes do not affect root', async () => {
    await sample(root, 3, async (fork, index) => {
      fork.write('src/index.ts', `version ${index}`)
      return index
    })

    expect(root.read('src/index.ts')).toBe('export const version = "1.0.0"')
  })

  it('forks are isolated from each other', async () => {
    const writtenContents: (string | null)[] = []

    await sample(root, 3, async (fork, index) => {
      fork.write('src/index.ts', `v${index}`)
      // Record what this fork sees after the write
      writtenContents[index] = fork.read('src/index.ts')
      return index
    })

    // Each fork should have written its own value
    expect(writtenContents[0]).toBe('v0')
    expect(writtenContents[1]).toBe('v1')
    expect(writtenContents[2]).toBe('v2')
  })

  it('forks are created with sequential sample-N labels', async () => {
    const labels: string[] = []

    await sample(root, 3, async (fork, _index) => {
      labels.push(fork.label)
      return fork.label
    })

    const sorted = [...labels].sort()
    expect(sorted).toEqual(['sample-0', 'sample-1', 'sample-2'])
  })

  it('negative count throws with message about valid range', async () => {
    await expect(sample(root, -1, async () => 'x')).rejects.toThrow(
      /between 1 and 10/,
    )
  })
})

// ---------------------------------------------------------------------------
// selectBest()
// ---------------------------------------------------------------------------

describe('selectBest()', () => {
  it('returns null for empty array', () => {
    const result = selectBest([], () => 0)
    expect(result).toBeNull()
  })

  it('returns null when all results have an error', () => {
    const results = [
      errResult<number>(0, 'fail-a'),
      errResult<number>(1, 'fail-b'),
      errResult<number>(2, 'fail-c'),
    ]

    expect(selectBest(results, r => r)).toBeNull()
  })

  it('returns the only successful result when all others errored', () => {
    const results = [
      errResult<number>(0, 'fail'),
      okResult<number>(1, 42),
      errResult<number>(2, 'fail'),
    ]

    const best = selectBest(results, r => r)
    expect(best).not.toBeNull()
    expect(best!.forkIndex).toBe(1)
    expect(best!.result).toBe(42)
  })

  it('selects the result with the highest score', () => {
    const results = [
      okResult(0, { quality: 3 }),
      okResult(1, { quality: 9 }),
      okResult(2, { quality: 6 }),
    ]

    const best = selectBest(results, r => r.quality)
    expect(best!.forkIndex).toBe(1)
    expect(best!.result.quality).toBe(9)
  })

  it('selects the first result when there is only one', () => {
    const results = [okResult(0, { score: 7 })]

    const best = selectBest(results, r => r.score)
    expect(best!.forkIndex).toBe(0)
  })

  it('tie: first encountered (lowest index among tied) wins', () => {
    // Both index 0 and index 2 score 10; index 0 comes first in the array
    const results = [
      okResult(0, 10),
      okResult(1, 5),
      okResult(2, 10),
    ]

    const best = selectBest(results, r => r)
    expect(best!.forkIndex).toBe(0)
  })

  it('errored results are completely ignored when scoring', () => {
    const results = [
      errResult<number>(0, 'crashed'),   // would score 999 if not skipped
      okResult<number>(1, 2),
      okResult<number>(2, 7),
    ]

    // Give a huge score to what the error result's result would be if it
    // weren't excluded — but since it's excluded the scorer never sees it.
    const best = selectBest(results, r => r === (undefined as unknown as number) ? 999 : r)
    expect(best!.forkIndex).toBe(2)
    expect(best!.result).toBe(7)
  })

  it('scorer receives the actual result value', () => {
    const scored: number[] = []
    const results = [okResult(0, 3), okResult(1, 1), okResult(2, 2)]

    selectBest(results, r => {
      scored.push(r)
      return r
    })

    expect(scored.sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('handles results where all but one have errors, returning that survivor', () => {
    const results = [
      errResult<string>(0, 'e1'),
      errResult<string>(1, 'e2'),
      okResult<string>(2, 'survivor'),
      errResult<string>(3, 'e3'),
    ]

    const best = selectBest(results, r => r.length)
    expect(best!.forkIndex).toBe(2)
    expect(best!.result).toBe('survivor')
  })
})

// ---------------------------------------------------------------------------
// commitBest()
// ---------------------------------------------------------------------------

describe('commitBest()', () => {
  let root: VirtualFS
  let forks: CopyOnWriteVFS[]

  beforeEach(() => {
    root = makeVFS()
    forks = [
      new CopyOnWriteVFS(root, 'sample-0'),
      new CopyOnWriteVFS(root, 'sample-1'),
      new CopyOnWriteVFS(root, 'sample-2'),
    ]
  })

  it('calls merge("theirs") on the winning fork, propagating changes to root', () => {
    forks[1]!.write('src/index.ts', 'winner content')

    const winner = okResult(1, 'score-value')
    commitBest(winner, forks)

    expect(root.read('src/index.ts')).toBe('winner content')
  })

  it('does not touch sibling forks', () => {
    forks[0]!.write('src/index.ts', 'fork0-change')
    forks[1]!.write('src/index.ts', 'fork1-change')
    forks[2]!.write('src/index.ts', 'fork2-change')

    // Spy on merge of forks[0] and forks[2] to ensure they are not called
    const mergeSpy0 = vi.spyOn(forks[0]!, 'merge')
    const mergeSpy2 = vi.spyOn(forks[2]!, 'merge')

    const winner = okResult(1, 'winner')
    commitBest(winner, forks)

    expect(mergeSpy0).not.toHaveBeenCalled()
    expect(mergeSpy2).not.toHaveBeenCalled()
  })

  it('throws when winner.forkIndex is out of bounds', () => {
    const winner = okResult(5, 'out-of-bounds')
    expect(() => commitBest(winner, forks)).toThrow(/No fork found at index 5/)
  })

  it('throws when forks array is empty', () => {
    const winner = okResult(0, 'any')
    expect(() => commitBest(winner, [])).toThrow(/No fork found at index 0/)
  })

  it('uses "theirs" strategy so fork content overwrites root content', () => {
    // Pre-modify root after fork creation to create a conflict scenario
    root.write('src/index.ts', 'root-changed-after-fork')
    forks[0]!.write('src/index.ts', 'fork-version')

    const winner = okResult(0, 'result')
    commitBest(winner, forks)

    // 'theirs' means fork wins
    expect(root.read('src/index.ts')).toBe('fork-version')
  })

  it('correctly merges additions from the winning fork to root', () => {
    forks[2]!.write('src/new-file.ts', 'brand new')

    const winner = okResult(2, 'anything')
    commitBest(winner, forks)

    expect(root.read('src/new-file.ts')).toBe('brand new')
  })

  it('correctly merges deletions from the winning fork to root', () => {
    forks[0]!.delete('src/utils.ts')

    const winner = okResult(0, 'anything')
    commitBest(winner, forks)

    expect(root.read('src/utils.ts')).toBeNull()
  })

  it('winner at index 0 works correctly', () => {
    forks[0]!.write('src/index.ts', 'fork0-wins')

    const winner = okResult(0, 'v')
    commitBest(winner, forks)

    expect(root.read('src/index.ts')).toBe('fork0-wins')
  })

  it('winner at last index works correctly', () => {
    const lastIndex = forks.length - 1
    forks[lastIndex]!.write('src/index.ts', 'last-fork-wins')

    const winner = okResult(lastIndex, 'v')
    commitBest(winner, forks)

    expect(root.read('src/index.ts')).toBe('last-fork-wins')
  })
})

// ---------------------------------------------------------------------------
// sampleAndCommitBest()
// ---------------------------------------------------------------------------

describe('sampleAndCommitBest()', () => {
  let root: VirtualFS

  beforeEach(() => {
    root = makeVFS()
  })

  it('returns null when all forks fail', async () => {
    const outcome = await sampleAndCommitBest(
      root,
      3,
      async () => {
        throw new Error('all fail')
      },
      () => 0,
    )

    expect(outcome).toBeNull()
  })

  it('root is unchanged when all forks fail', async () => {
    const originalContent = root.read('src/index.ts')

    await sampleAndCommitBest(
      root,
      2,
      async () => {
        throw new Error('fail')
      },
      () => 0,
    )

    expect(root.read('src/index.ts')).toBe(originalContent)
  })

  it('returns { winner, allResults } when at least one fork succeeds', async () => {
    const outcome = await sampleAndCommitBest(
      root,
      3,
      async (_fork, index) => index,
      r => r,
    )

    expect(outcome).not.toBeNull()
    expect(outcome!.winner).toBeDefined()
    expect(outcome!.allResults).toHaveLength(3)
  })

  it('winner has the highest score', async () => {
    const outcome = await sampleAndCommitBest(
      root,
      3,
      async (_fork, index) => ({ quality: (index + 1) * 10 }),
      r => r.quality,
    )

    expect(outcome!.winner.result.quality).toBe(30) // index 2 → quality 30
  })

  it('commits the winning fork changes to the source VFS', async () => {
    await sampleAndCommitBest(
      root,
      3,
      async (fork, index) => {
        const quality = (index + 1) * 10
        fork.write('src/index.ts', `// quality: ${quality}`)
        return { quality }
      },
      r => r.quality,
    )

    expect(root.read('src/index.ts')).toBe('// quality: 30')
  })

  it('only the winning fork is committed — other fork writes do not reach root', async () => {
    await sampleAndCommitBest(
      root,
      3,
      async (fork, index) => {
        fork.write(`src/sample-${index}.ts`, `sample ${index}`)
        if (index === 1) {
          fork.write('src/index.ts', 'best version')
        }
        return { quality: index === 1 ? 100 : 0 }
      },
      r => r.quality,
    )

    expect(root.read('src/index.ts')).toBe('best version')
    expect(root.read('src/sample-1.ts')).toBe('sample 1')
    // Non-winning forks must NOT appear in root
    expect(root.read('src/sample-0.ts')).toBeNull()
    expect(root.read('src/sample-2.ts')).toBeNull()
  })

  it('allResults contains entries for every fork including failed ones', async () => {
    const outcome = await sampleAndCommitBest(
      root,
      4,
      async (_fork, index) => {
        if (index === 2) throw new Error('middle-fail')
        return index
      },
      r => r,
    )

    expect(outcome).not.toBeNull()
    expect(outcome!.allResults).toHaveLength(4)

    const sorted = [...outcome!.allResults].sort((a, b) => a.forkIndex - b.forkIndex)
    expect(sorted[2]!.error).toBe('middle-fail')
    expect(sorted[0]!.error).toBeUndefined()
    expect(sorted[1]!.error).toBeUndefined()
    expect(sorted[3]!.error).toBeUndefined()
  })

  it('count=0 throws with valid-range message', async () => {
    await expect(
      sampleAndCommitBest(root, 0, async () => 'x', () => 0),
    ).rejects.toThrow(/between 1 and 10/)
  })

  it('count=11 throws with valid-range message', async () => {
    await expect(
      sampleAndCommitBest(root, 11, async () => 'x', () => 0),
    ).rejects.toThrow(/between 1 and 10/)
  })

  it('count=1 succeeds and returns the single result as winner', async () => {
    const outcome = await sampleAndCommitBest(
      root,
      1,
      async (fork) => {
        fork.write('src/index.ts', 'single attempt')
        return 42
      },
      r => r,
    )

    expect(outcome).not.toBeNull()
    expect(outcome!.winner.result).toBe(42)
    expect(outcome!.allResults).toHaveLength(1)
    expect(root.read('src/index.ts')).toBe('single attempt')
  })

  it('count=10 works and selects the highest scorer', async () => {
    const outcome = await sampleAndCommitBest(
      root,
      10,
      async (fork, index) => {
        fork.write('src/index.ts', `v${index}`)
        return index
      },
      r => r,
    )

    expect(outcome).not.toBeNull()
    expect(outcome!.winner.result).toBe(9)      // highest index = highest score
    expect(outcome!.allResults).toHaveLength(10)
    expect(root.read('src/index.ts')).toBe('v9')
  })

  it('when a single fork fails and the rest succeed, the best non-failing wins', async () => {
    const outcome = await sampleAndCommitBest(
      root,
      3,
      async (_fork, index) => {
        if (index === 0) throw new Error('first-fails')
        return index * 5
      },
      r => r,
    )

    expect(outcome).not.toBeNull()
    // index=1 → 5, index=2 → 10; winner is index=2
    expect(outcome!.winner.result).toBe(10)
    expect(outcome!.winner.forkIndex).toBe(2)
  })

  it('winner object has forkIndex, result, index, durationMs and no error', async () => {
    const outcome = await sampleAndCommitBest(
      root,
      2,
      async (_fork, index) => `result-${index}`,
      r => r.length,
    )

    const w = outcome!.winner
    expect(w.forkIndex).toBeTypeOf('number')
    expect(w.index).toBeTypeOf('number')
    expect(w.durationMs).toBeGreaterThanOrEqual(0)
    expect(w.error).toBeUndefined()
    expect(w.result).toMatch(/^result-/)
  })
})
