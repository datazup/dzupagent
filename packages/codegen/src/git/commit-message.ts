/**
 * LLM-generated commit messages.
 *
 * Follows Aider's pattern: use a cheap/fast model tier to generate
 * commit messages from diffs, keeping costs low.
 */
import type { ModelRegistry, ModelTier } from '@dzipagent/core'
import { invokeWithTimeout } from '@dzipagent/core'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { CommitMessageConfig, GitDiffResult } from './git-types.js'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: CommitMessageConfig = {
  style: 'conventional',
  maxSubjectLength: 72,
  includeFileList: false,
}

const SYSTEM_PROMPT = `You are a commit message generator. Given a git diff, produce a clear, concise commit message.

Rules:
- Use imperative mood ("add", "fix", "update", not "added", "fixed", "updated")
- Focus on the "why" not the "what" — the diff already shows the "what"
- Keep the subject line under {{maxSubjectLength}} characters
- Do NOT include a body unless the change is complex (3+ files with different purposes)
- Do NOT wrap the message in quotes or markdown code blocks
- Respond with ONLY the commit message, nothing else

{{styleGuide}}`

const CONVENTIONAL_GUIDE = `Use conventional commit format: type(scope): description
Types: feat, fix, refactor, docs, test, chore, perf, ci, build, style
Scope is optional but helpful (e.g., feat(auth): add OAuth2 flow)`

const DESCRIPTIVE_GUIDE = `Write a short descriptive message. No special format required.
Example: "add user authentication with JWT tokens"`

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generate a commit message from a diff using a cheap LLM.
 *
 * @param registry - Model registry to get the cheap model
 * @param diff - The diff result to describe
 * @param config - Optional configuration overrides
 * @param modelTier - Model tier to use (default: 'chat' — cheapest)
 * @returns Generated commit message string
 */
export async function generateCommitMessage(
  registry: ModelRegistry,
  diff: GitDiffResult,
  config?: Partial<CommitMessageConfig>,
  modelTier: ModelTier = 'chat',
): Promise<string> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  const model = registry.getModel(modelTier)

  const systemPrompt = SYSTEM_PROMPT
    .replace('{{maxSubjectLength}}', String(cfg.maxSubjectLength))
    .replace('{{styleGuide}}', cfg.style === 'conventional' ? CONVENTIONAL_GUIDE : DESCRIPTIVE_GUIDE)

  // Build a concise diff summary to minimize tokens
  const diffSummary = buildDiffSummary(diff, cfg)

  const response = await invokeWithTimeout(model, [
    new SystemMessage(systemPrompt),
    new HumanMessage(diffSummary),
  ], { timeoutMs: 15_000 })

  // Clean up the response
  let message = (typeof response.content === 'string' ? response.content : '').trim()

  // Remove any markdown fencing
  message = message.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')

  // Remove surrounding quotes
  message = message.replace(/^["']|["']$/g, '')

  // Truncate subject line if too long
  const lines = message.split('\n')
  if (lines[0] && lines[0].length > cfg.maxSubjectLength) {
    lines[0] = lines[0].slice(0, cfg.maxSubjectLength - 3) + '...'
    message = lines.join('\n')
  }

  return message
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDiffSummary(diff: GitDiffResult, config: CommitMessageConfig): string {
  const parts: string[] = []

  parts.push(`Changes: ${diff.filesChanged} file(s), +${diff.insertions} -${diff.deletions}`)

  if (config.includeFileList && diff.files.length > 0) {
    parts.push('')
    parts.push('Files:')
    for (const f of diff.files.slice(0, 20)) {
      parts.push(`  ${f.path} (+${f.insertions} -${f.deletions})`)
    }
    if (diff.files.length > 20) {
      parts.push(`  ... and ${diff.files.length - 20} more`)
    }
  }

  // Include the actual diff, truncated to keep cost low
  const maxDiffChars = 4_000
  if (diff.diff.length > 0) {
    parts.push('')
    parts.push('Diff:')
    if (diff.diff.length > maxDiffChars) {
      parts.push(diff.diff.slice(0, maxDiffChars))
      parts.push(`\n[... truncated, ${diff.diff.length - maxDiffChars} chars omitted]`)
    } else {
      parts.push(diff.diff)
    }
  }

  return parts.join('\n')
}
