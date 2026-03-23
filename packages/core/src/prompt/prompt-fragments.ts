/**
 * Composable prompt fragments for code generation pipelines.
 * Derived from Claude Code system prompt patterns.
 *
 * Usage: Concatenate relevant fragments as preamble before node-specific instructions.
 */

export const FRAGMENT_CORE_PRINCIPLES = `## Core Principles (non-negotiable)

1. INLINE over ABSTRACT — Duplicate 2-3 lines rather than create a one-use utility function
2. VALIDATE at BOUNDARIES — Check user input and external API responses; trust internal function calls
3. SCOPE STRICT — Generate only what the plan specifies; no bonus features, no proactive cleanup
4. SECURITY FIRST — No raw SQL, no eval(), no v-html without sanitize, no hardcoded secrets
5. ACTION over EXPLANATION — Lead with code, not reasoning; explain only non-obvious decisions`

export const FRAGMENT_SECURITY_CHECKLIST = `## Security Checklist

Before generating code, verify these constraints:
- No raw SQL queries — use ORM/query builder only
- No unsanitized user input in queries, templates, or shell commands
- No hardcoded API keys, passwords, or secrets — use environment variables
- No eval(), Function(), exec() — never execute dynamic code strings
- No v-html or dangerouslySetInnerHTML without DOMPurify sanitization
- Authentication required on all mutation endpoints
- Tenant isolation via tenantId in every database query
- Input validation via Zod schemas at every API boundary`

export const FRAGMENT_SIMPLICITY = `## Simplicity Rules

- Don't create helpers, utilities, or abstractions for one-time operations
- Don't design for hypothetical future requirements
- Three similar lines of code is better than a premature abstraction
- Don't add error handling for scenarios that can't happen — trust framework guarantees
- Only validate at system boundaries (user input, external APIs)
- Don't add docstrings, comments, or type annotations to code that is self-evident
- Don't add features, refactor code, or make "improvements" beyond what was asked`

export const FRAGMENT_READ_DISCIPLINE = `## Read-Before-Generate Discipline

Before generating code for this layer:
1. Review existing code in {{existing_files}} for established patterns
2. Match naming conventions, import style, and error handling from existing code
3. If existing code uses specific patterns (e.g., repository pattern, composable pattern), follow them
4. Consistency with existing code is MORE important than "better" alternatives`

export const FRAGMENT_SCOPE_BOUNDARY = `## Scope Boundary

Generate ONLY the files and functions specified in the feature plan.
- No bonus utility files
- No extra error classes beyond what's needed
- No additional routes or endpoints not in the plan
- No proactive refactoring of surrounding code
- If a file in the plan is not needed, skip it — don't generate empty stubs`

export const FRAGMENT_VERIFICATION_MINDSET = `## Verification Mindset

When validating generated code, try to BREAK it, not confirm it works.
The first 80% is easy. Your value is finding the last 20%.

Adversarial checks to consider:
- Empty inputs (empty string, null, undefined, 0, -1)
- Boundary values (MAX_INT, very long strings, unicode, special characters)
- Duplicate operations (same create request twice — idempotent or error?)
- Missing auth (no token, expired token, wrong tenant)
- Concurrency (parallel requests to same resource)`

export const FRAGMENT_BLOCKED_HANDLING = `## When Stuck

If your approach is blocked, do NOT retry the same thing.
- Diagnose the root cause first
- Try a fundamentally different approach
- If 2 different approaches fail, escalate — don't loop
- Never weaken security, remove validation, or downgrade types to work around errors`

export const FRAGMENT_OUTPUT_EFFICIENCY = `## Output Format

- Lead with code, not explanation
- Include comments only for non-obvious "why" decisions
- No filler text, no restating what was asked
- Full code detail — never truncate implementations with "..."
- If you can't complete all files, prioritize by dependency order and note what's missing`

export const FRAGMENT_WORKER_REPORT = `## Report Format

End your output with a structured report:
- Scope: [what was generated, one sentence]
- Result: [quality score, file count, test status]
- Key files: [top 5 files with their purpose]
- Issues: [known limitations or deferred items, if any]`

/** All fragments indexed by name for dynamic composition */
export const PROMPT_FRAGMENTS: Record<string, string> = {
  core_principles: FRAGMENT_CORE_PRINCIPLES,
  security_checklist: FRAGMENT_SECURITY_CHECKLIST,
  simplicity: FRAGMENT_SIMPLICITY,
  read_discipline: FRAGMENT_READ_DISCIPLINE,
  scope_boundary: FRAGMENT_SCOPE_BOUNDARY,
  verification_mindset: FRAGMENT_VERIFICATION_MINDSET,
  blocked_handling: FRAGMENT_BLOCKED_HANDLING,
  output_efficiency: FRAGMENT_OUTPUT_EFFICIENCY,
  worker_report: FRAGMENT_WORKER_REPORT,
}

/** Compose multiple fragments into a single preamble string */
export function composeFragments(...names: string[]): string {
  return names
    .map(name => PROMPT_FRAGMENTS[name])
    .filter(Boolean)
    .join('\n\n---\n\n')
}
