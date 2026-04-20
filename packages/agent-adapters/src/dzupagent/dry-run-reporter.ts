/**
 * DryRunReporter -- emits dry-run diagnostics for DzupAgentSyncer.
 *
 * Supports two modes:
 *   - 'console' streams human-readable lines to stdout as they happen.
 *   - 'json' buffers entries and flushes a single JSON array at the end.
 */

export type DryRunReporterMode = 'console' | 'json'

export type DryRunEntryType = 'diff' | 'new' | 'write' | 'overwrite'

export interface DryRunEntry {
  type: DryRunEntryType
  path: string
  diff?: string
}

export interface DryRunReporterOptions {
  format: DryRunReporterMode
}

export class DryRunReporter {
  private readonly mode: DryRunReporterMode
  private readonly entries: DryRunEntry[] = []

  constructor(mode: DryRunReporterMode | DryRunReporterOptions = 'console') {
    if (typeof mode === 'string') {
      this.mode = mode
    } else {
      this.mode = mode.format
    }
  }

  /**
   * Convenience entry point — reports a batch of per-file diffs.
   *
   * - console mode: prints each diff with a header.
   * - json mode: writes a single `{files: [...]}` JSON blob to stdout.
   * - empty input: emits nothing in either mode.
   */
  report(diffs: Array<{ path: string; diff: string }>): void {
    if (diffs.length === 0) return

    if (this.mode === 'json') {
      const payload = {
        files: diffs.map((d) => ({ path: d.path, diff: d.diff })),
      }
      process.stdout.write(JSON.stringify(payload) + '\n')
      return
    }

    for (const { path, diff } of diffs) {
      console.log(`\nDiff for ${path}:`)
      console.log(diff)
    }
  }

  reportDiff(path: string, diff: string): void {
    if (this.mode === 'json') {
      this.entries.push({ type: 'diff', path, diff })
      return
    }
    console.log(`\nDiff for ${path}:`)
    console.log(diff)
  }

  reportNewFile(path: string): void {
    if (this.mode === 'json') {
      this.entries.push({ type: 'new', path })
      return
    }
    console.log(`\n[dry-run] Would create new file: ${path}`)
  }

  reportWouldWrite(path: string): void {
    if (this.mode === 'json') {
      this.entries.push({ type: 'write', path })
      return
    }
    console.log(`[dry-run] Would write: ${path}`)
  }

  reportWouldOverwrite(path: string): void {
    if (this.mode === 'json') {
      this.entries.push({ type: 'overwrite', path })
      return
    }
    console.log(`[dry-run] Would overwrite diverged file: ${path}`)
  }

  flush(): void {
    if (this.mode !== 'json') return
    console.log(JSON.stringify(this.entries, null, 2))
  }
}
