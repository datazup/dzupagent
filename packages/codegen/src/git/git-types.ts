/**
 * Git integration type definitions.
 *
 * Types for git operations, tool results, and commit message generation.
 */

/** Git file status codes */
export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

/** A file entry in git status output */
export interface GitFileEntry {
  path: string
  status: GitFileStatus
  /** Original path for renamed files */
  originalPath?: string
  /** Whether the file is staged */
  staged: boolean
}

/** Result of git status */
export interface GitStatusResult {
  branch: string
  /** Upstream branch if tracking */
  upstream?: string
  ahead: number
  behind: number
  files: GitFileEntry[]
  /** Whether the working tree is clean */
  clean: boolean
}

/** Result of git diff */
export interface GitDiffResult {
  /** Unified diff text */
  diff: string
  /** Number of files changed */
  filesChanged: number
  insertions: number
  deletions: number
  /** Per-file summary */
  files: Array<{
    path: string
    insertions: number
    deletions: number
  }>
}

/** Result of git log */
export interface GitLogEntry {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
}

/** Result of git commit */
export interface GitCommitResult {
  hash: string
  message: string
  filesChanged: number
}

/** Configuration for the git executor */
export interface GitExecutorConfig {
  /** Working directory (default: process.cwd()) */
  cwd?: string
  /** Allowed workspace roots. When provided, cwd must resolve inside one of these roots. */
  allowedRoots?: string[]
  /** Git command timeout in milliseconds (default 30_000) */
  timeoutMs?: number
  /** Maximum output buffer size in bytes (default 10MB) */
  maxBuffer?: number
}

/** Configuration for commit message generation */
export interface CommitMessageConfig {
  /** Style: 'conventional' (feat/fix/...) or 'descriptive' */
  style: 'conventional' | 'descriptive'
  /** Maximum length of the subject line (default 72) */
  maxSubjectLength: number
  /** Include file list in body */
  includeFileList: boolean
}
