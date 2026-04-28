/**
 * LocalWorkspace — Workspace implementation backed by the local filesystem.
 *
 * Uses Node fs.promises for file I/O, child_process.execFile for commands,
 * and optionally shells out to ripgrep for search.
 */
import { readFile, writeFile, mkdir, readdir, access, realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { resolve, relative, isAbsolute, dirname } from 'node:path'

import {
  WorkspacePathSecurityError,
  type Workspace,
  type WorkspaceOptions,
  type SearchResult,
  type CommandResult,
} from './types.js'

// ---------------------------------------------------------------------------
// Glob-to-regex helper (supports *, **, ?)
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
  let regexStr = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any depth
        regexStr += '.*'
        i += 2
        // consume optional trailing /
        if (pattern[i] === '/') i++
      } else {
        // * matches anything except /
        regexStr += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      regexStr += '[^/]'
      i++
    } else if (ch === '.') {
      regexStr += '\\.'
      i++
    } else {
      regexStr += ch
      i++
    }
  }
  return new RegExp(`^${regexStr}$`)
}

// ---------------------------------------------------------------------------
// Ripgrep JSON output parsing
// ---------------------------------------------------------------------------

interface RipgrepMatch {
  type: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
    submatches?: Array<{ match?: { text?: string }; start?: number }>
  }
}

function parseRipgrepJson(stdout: string): SearchResult[] {
  const results: SearchResult[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let parsed: RipgrepMatch
    try {
      parsed = JSON.parse(line) as RipgrepMatch
    } catch {
      continue
    }
    if (parsed.type !== 'match' || !parsed.data) continue
    const d = parsed.data
    const filePath = d.path?.text ?? ''
    const lineNumber = d.line_number ?? 0
    const lineText = d.lines?.text?.replace(/\n$/, '') ?? ''
    const firstSub = d.submatches?.[0]
    const column = (firstSub?.start ?? 0) + 1
    const matchText = firstSub?.match?.text ?? lineText
    results.push({
      filePath,
      line: lineNumber,
      column,
      matchText,
      context: { before: '', after: lineText },
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// LocalWorkspace
// ---------------------------------------------------------------------------

export class LocalWorkspace implements Workspace {
  readonly rootDir: string
  readonly options: WorkspaceOptions
  private readonly rootRealDir: string

  constructor(options: WorkspaceOptions) {
    this.rootDir = resolve(options.rootDir)
    try {
      this.rootRealDir = realpathSync(this.rootDir)
    } catch {
      this.rootRealDir = this.rootDir
    }
    this.options = options
  }

  // ---- path helpers -------------------------------------------------------

  private assertContainedAbsolute(
    absPath: string,
    attemptedPath: string,
    rootDir = this.rootDir,
  ): void {
    const rel = relative(rootDir, absPath)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
    throw new WorkspacePathSecurityError(attemptedPath, this.rootDir)
  }

  private resolvePath(p: string): string {
    if (isAbsolute(p)) {
      throw new WorkspacePathSecurityError(p, this.rootDir)
    }

    const abs = resolve(this.rootDir, p)
    this.assertContainedAbsolute(abs, p)
    return abs
  }

  private assertSafeGlob(glob: string): void {
    if (isAbsolute(glob) || glob.split(/[\\/]+/).includes('..')) {
      throw new WorkspacePathSecurityError(glob, this.rootDir)
    }
  }

  private async assertRealPathContained(absPath: string, attemptedPath: string): Promise<void> {
    const resolvedRealPath = await realpath(absPath)
    this.assertContainedAbsolute(resolvedRealPath, attemptedPath, this.rootRealDir)
  }

  // ---- Workspace interface ------------------------------------------------

  async readFile(path: string): Promise<string> {
    const abs = this.resolvePath(path)
    await this.assertRealPathContained(abs, path)
    return readFile(abs, 'utf-8')
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = this.resolvePath(path)
    await mkdir(dirname(abs), { recursive: true })
    await this.assertRealPathContained(dirname(abs), path)
    try {
      await this.assertRealPathContained(abs, path)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') throw error
    }
    await writeFile(abs, content, 'utf-8')
  }

  async listFiles(glob: string): Promise<string[]> {
    this.assertSafeGlob(glob)
    const regex = globToRegex(glob)
    const allFiles = await this.walkDir(this.rootDir)
    return allFiles.filter((f) => regex.test(f)).sort()
  }

  async search(
    query: string,
    options?: { glob?: string; maxResults?: number },
  ): Promise<SearchResult[]> {
    if (options?.glob) {
      this.assertSafeGlob(options.glob)
    }

    const maxResults = options?.maxResults ?? this.options.search?.maxResults ?? 200
    const provider = this.options.search?.provider ?? 'ripgrep'

    // Try ripgrep first (unless explicitly set to something else)
    if (provider !== 'builtin') {
      const rgResult = await this.searchWithRipgrep(query, options?.glob, maxResults)
      if (rgResult !== null) return rgResult
    }

    // Fallback: builtin search
    return this.searchBuiltin(query, options?.glob, maxResults)
  }

  async runCommand(
    cmd: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<CommandResult> {
    const allowedCommands = this.options.command?.allowedCommands
    if (allowedCommands && !allowedCommands.includes(cmd)) {
      return {
        exitCode: 126,
        stdout: '',
        stderr: `Command '${cmd}' is not in the allowed commands list.`,
        timedOut: false,
      }
    }

    const timeoutMs =
      options?.timeoutMs ?? this.options.command?.timeoutMs ?? 30_000
    const cwd = options?.cwd ? this.resolvePath(options.cwd) : this.rootDir
    if (options?.cwd) {
      await this.assertRealPathContained(cwd, options.cwd)
    }

    return new Promise<CommandResult>((resolvePromise) => {
      const child = execFileCb(
        cmd,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const timedOut = !!(error && 'killed' in error && error.killed)
          const exitCode =
            error && 'code' in error && typeof error.code === 'number'
              ? error.code
              : error
                ? 1
                : 0
          resolvePromise({
            exitCode,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            timedOut,
          })
        },
      )
      // Safety: ensure we don't leave orphaned processes
      child.on('error', () => {
        /* handled by callback */
      })
    })
  }

  async exists(path: string): Promise<boolean> {
    const abs = this.resolvePath(path)
    try {
      await access(abs)
      await this.assertRealPathContained(abs, path)
      return true
    } catch (error) {
      if (error instanceof WorkspacePathSecurityError) throw error
      return false
    }
  }

  // ---- private helpers ----------------------------------------------------

  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = []
    try {
      const entries = await readdir(dir, { withFileTypes: true, recursive: true })
      for (const entry of entries) {
        if (entry.isFile()) {
          // entry.parentPath is available in Node 20.12+ (same as entry.path)
          const parentDir = (entry as { parentPath?: string }).parentPath ?? dir
          const fullPath = resolve(parentDir, entry.name)
          this.assertContainedAbsolute(fullPath, fullPath)
          const workspacePath = relative(this.rootDir, fullPath)
          if (!workspacePath.startsWith('..') && !isAbsolute(workspacePath)) {
            results.push(workspacePath)
          }
        }
      }
    } catch {
      // Directory does not exist or is not readable
    }
    return results
  }

  private async searchWithRipgrep(
    query: string,
    fileGlob: string | undefined,
    maxResults: number,
  ): Promise<SearchResult[] | null> {
    const args = ['--json', '--max-count', String(maxResults), query]
    if (fileGlob) {
      args.push('--glob', fileGlob)
    }

    try {
      const result = await this.runCommand('rg', args)
      // rg returns exit code 1 for "no matches" and 2+ for errors
      if (result.exitCode > 1) return null
      const parsed = parseRipgrepJson(result.stdout)
      return parsed.slice(0, maxResults)
    } catch {
      return null
    }
  }

  private async searchBuiltin(
    query: string,
    fileGlob: string | undefined,
    maxResults: number,
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = []
    const allFiles = await this.walkDir(this.rootDir)
    const globRegex = fileGlob ? globToRegex(fileGlob) : null

    for (const filePath of allFiles) {
      if (results.length >= maxResults) break
      if (globRegex && !globRegex.test(filePath)) continue

      let content: string
      try {
        content = await readFile(resolve(this.rootDir, filePath), 'utf-8')
      } catch {
        continue
      }

      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break
        const line = lines[i]!
        const col = line.indexOf(query)
        if (col === -1) continue
        results.push({
          filePath,
          line: i + 1,
          column: col + 1,
          matchText: query,
          context: {
            before: lines[i - 1] ?? '',
            after: lines[i + 1] ?? '',
          },
        })
      }
    }
    return results
  }
}
