/**
 * Unified diff builder for DzupAgentSyncer dry-run output.
 *
 * Split out of `syncer.ts` (MC-017). Implements a simple Myers/LCS-style
 * diff that produces unified hunks with three lines of context.
 */

export function buildUnifiedDiff(oldText: string, newText: string, filePath: string): string {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const header = `--- ${filePath} (current)\n+++ ${filePath} (source)\n`

  // Simple Myers-like LCS diff — produces unified hunks
  const m = oldLines.length
  const n = newLines.length

  // Build edit script via DP
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i]![j] = (dp[i + 1]?.[j + 1] ?? 0) + 1
      } else {
        dp[i]![j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0)
      }
    }
  }

  // Collect raw diff ops: ' ' keep, '-' remove, '+' add
  const ops: Array<{ op: ' ' | '-' | '+'; line: string }> = []
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      ops.push({ op: ' ', line: oldLines[i] ?? '' })
      i++
      j++
    } else if (j < n && (i >= m || (dp[i + 1]?.[j] ?? 0) <= (dp[i]?.[j + 1] ?? 0))) {
      ops.push({ op: '+', line: newLines[j] ?? '' })
      j++
    } else {
      ops.push({ op: '-', line: oldLines[i] ?? '' })
      i++
    }
  }

  // Group into hunks (context = 3)
  const CONTEXT = 3
  const changedIdx = ops.reduce<number[]>((acc, o, idx) => {
    if (o.op !== ' ') acc.push(idx)
    return acc
  }, [])

  if (changedIdx.length === 0) return ''

  const hunks: string[] = []
  let k = 0
  while (k < changedIdx.length) {
    const start = Math.max(0, (changedIdx[k] ?? 0) - CONTEXT)
    let end = changedIdx[k] ?? 0
    while (k < changedIdx.length && (changedIdx[k] ?? 0) <= end + CONTEXT * 2) {
      end = changedIdx[k] ?? end
      k++
    }
    end = Math.min(ops.length - 1, end + CONTEXT)

    const slice = ops.slice(start, end + 1)
    const oldStart = slice.filter((o) => o.op !== '+').length > 0 ? start + 1 : start + 1
    const newStart = start + 1
    const oldCount = slice.filter((o) => o.op !== '+').length
    const newCount = slice.filter((o) => o.op !== '-').length
    const hunkHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
    const lines = slice.map((o) => `${o.op}${o.line}`)
    hunks.push([hunkHeader, ...lines].join('\n'))
  }

  return header + hunks.join('\n')
}
