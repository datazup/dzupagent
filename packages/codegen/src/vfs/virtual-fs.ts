/**
 * In-memory virtual filesystem for code generation.
 * All generated code lives here during pipeline execution.
 */

export interface FileDiff {
  path: string
  type: 'added' | 'modified' | 'deleted'
  oldContent?: string | undefined
  newContent?: string | undefined
}

export class VirtualFS {
  private files: Map<string, string>

  constructor(initial?: Record<string, string>) {
    this.files = new Map(initial ? Object.entries(initial) : [])
  }

  write(path: string, content: string): void {
    this.files.set(path, content)
  }

  read(path: string): string | null {
    return this.files.get(path) ?? null
  }

  exists(path: string): boolean {
    return this.files.has(path)
  }

  delete(path: string): boolean {
    return this.files.delete(path)
  }

  /** List all file paths, optionally filtered by directory prefix */
  list(directory?: string): string[] {
    const paths = [...this.files.keys()].sort()
    if (!directory) return paths
    const prefix = directory.endsWith('/') ? directory : `${directory}/`
    return paths.filter(p => p.startsWith(prefix))
  }

  /** Number of files */
  get size(): number {
    return this.files.size
  }

  /** Export as a plain Record<string, string> snapshot */
  toSnapshot(): Record<string, string> {
    const snapshot: Record<string, string> = {}
    for (const [path, content] of this.files) {
      snapshot[path] = content
    }
    return snapshot
  }

  /** Create a VirtualFS from a snapshot */
  static fromSnapshot(snapshot: Record<string, string>): VirtualFS {
    return new VirtualFS(snapshot)
  }

  /** Compute diff between this VFS and another */
  diff(other: VirtualFS): FileDiff[] {
    const diffs: FileDiff[] = []
    const otherSnapshot = other.toSnapshot()
    const thisSnapshot = this.toSnapshot()

    // Files in other but not in this (added)
    // Files in both but different content (modified)
    for (const [path, content] of Object.entries(otherSnapshot)) {
      if (!(path in thisSnapshot)) {
        diffs.push({ path, type: 'added', newContent: content })
      } else if (thisSnapshot[path] !== content) {
        diffs.push({ path, type: 'modified', oldContent: thisSnapshot[path], newContent: content })
      }
    }

    // Files in this but not in other (deleted)
    for (const path of Object.keys(thisSnapshot)) {
      if (!(path in otherSnapshot)) {
        diffs.push({ path, type: 'deleted', oldContent: thisSnapshot[path] })
      }
    }

    return diffs
  }

  /** Merge another VFS into this one (last-write-wins) */
  merge(other: VirtualFS): void {
    for (const [path, content] of other.files) {
      this.files.set(path, content)
    }
  }
}
