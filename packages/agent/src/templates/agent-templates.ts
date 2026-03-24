/**
 * Pre-built agent templates for common use cases.
 *
 * Templates define the configuration shape for an agent but do NOT instantiate
 * one — the consumer is responsible for resolving model instances and tool
 * implementations based on the `modelTier` and `suggestedTools` hints.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A pre-built agent template describing a reusable agent persona. */
export interface AgentTemplate {
  /** Unique template identifier (kebab-case). */
  id: string
  /** Human-readable name. */
  name: string
  /** Short description of the agent's purpose. */
  description: string
  /** System-level instructions injected as the agent's persona. */
  instructions: string
  /** Recommended model tier — helps the consumer pick the right model. */
  modelTier: 'chat' | 'reasoning' | 'codegen'
  /**
   * Suggested tool names the agent works best with.
   * These are *hints* — actual `StructuredToolInterface` instances must be
   * supplied by the consumer when constructing the `ForgeAgent`.
   */
  suggestedTools: string[]
  /** Guardrail presets (sensible defaults per use-case). */
  guardrails: {
    maxTokens: number
    maxCostCents: number
    maxIterations: number
  }
  /** Tags for categorization and discovery. */
  tags: string[]
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

const codeReviewer: AgentTemplate = {
  id: 'code-reviewer',
  name: 'Code Reviewer',
  description: 'Analyzes code for bugs, security vulnerabilities, performance issues, and style violations.',
  instructions: [
    'You are an expert code reviewer.',
    'Analyze code changes for: security vulnerabilities (OWASP Top 10), logic bugs,',
    'performance issues, style violations, and best practice adherence.',
    'Provide specific, actionable feedback with line references.',
    'Categorize issues as critical/warning/suggestion.',
  ].join(' '),
  modelTier: 'reasoning',
  suggestedTools: ['read_file', 'search_code', 'git_diff'],
  guardrails: {
    maxTokens: 50_000,
    maxCostCents: 25,
    maxIterations: 5,
  },
  tags: ['code-quality', 'review', 'security'],
}

const dataAnalyst: AgentTemplate = {
  id: 'data-analyst',
  name: 'Data Analyst',
  description: 'Explores, analyzes, and visualizes data from various sources.',
  instructions: [
    'You are a data analyst.',
    'Connect to data sources, explore schemas, write SQL queries, perform statistical',
    'analysis, and generate insights.',
    'Present findings with clear explanations.',
    'Always use parameterized queries.',
    'Default to read-only operations unless explicitly told to modify data.',
  ].join(' '),
  modelTier: 'reasoning',
  suggestedTools: ['db_query', 'read_file', 'write_file'],
  guardrails: {
    maxTokens: 100_000,
    maxCostCents: 50,
    maxIterations: 15,
  },
  tags: ['data', 'analytics', 'sql', 'visualization'],
}

const devopsAgent: AgentTemplate = {
  id: 'devops-agent',
  name: 'DevOps Agent',
  description: 'Manages infrastructure, CI/CD pipelines, containers, and deployments.',
  instructions: [
    'You are a DevOps engineer.',
    'Manage Docker configurations, CI/CD pipelines, Kubernetes manifests, and',
    'infrastructure-as-code.',
    'Analyze deployment failures, optimize build times, and ensure security best practices.',
    'Always validate configurations before applying.',
    'Never delete production resources without explicit confirmation.',
  ].join(' '),
  modelTier: 'codegen',
  suggestedTools: ['read_file', 'write_file', 'edit_file', 'execute_command', 'git_status'],
  guardrails: {
    maxTokens: 150_000,
    maxCostCents: 75,
    maxIterations: 20,
  },
  tags: ['devops', 'infrastructure', 'ci-cd', 'docker', 'kubernetes'],
}

const securityAuditor: AgentTemplate = {
  id: 'security-auditor',
  name: 'Security Auditor',
  description: 'Performs automated security assessments and vulnerability scanning.',
  instructions: [
    'You are a security auditor.',
    'Perform static analysis for OWASP Top 10 vulnerabilities, scan dependencies for',
    'known CVEs, review authentication/authorization logic, check for hardcoded secrets,',
    'and validate input sanitization.',
    'Generate a structured security report with severity ratings and remediation steps.',
  ].join(' '),
  modelTier: 'reasoning',
  suggestedTools: ['read_file', 'search_code', 'list_files'],
  guardrails: {
    maxTokens: 80_000,
    maxCostCents: 40,
    maxIterations: 10,
  },
  tags: ['security', 'audit', 'vulnerability', 'owasp'],
}

const documentationAgent: AgentTemplate = {
  id: 'documentation-agent',
  name: 'Documentation Agent',
  description: 'Generates and maintains technical documentation, READMEs, and API docs.',
  instructions: [
    'You are a technical writer.',
    'Generate API documentation from code, create README files, produce architecture',
    'diagrams in Mermaid syntax, and maintain changelogs.',
    'Write clear, concise documentation that matches the project\'s style.',
    'Include code examples where helpful.',
  ].join(' '),
  modelTier: 'chat',
  suggestedTools: ['read_file', 'write_file', 'list_files', 'search_code'],
  guardrails: {
    maxTokens: 120_000,
    maxCostCents: 30,
    maxIterations: 15,
  },
  tags: ['documentation', 'api-docs', 'readme', 'technical-writing'],
}

const migrationAgent: AgentTemplate = {
  id: 'migration-agent',
  name: 'Migration Agent',
  description: 'Migrates codebases between frameworks, libraries, or major versions.',
  instructions: [
    'You are a migration specialist.',
    'Analyze source codebases, map framework-specific patterns to target equivalents,',
    'and execute migrations in dependency order.',
    'Always run tests after each migration step.',
    'Preserve existing functionality — no regressions.',
    'Create a migration plan before making changes.',
  ].join(' '),
  modelTier: 'codegen',
  suggestedTools: ['read_file', 'write_file', 'edit_file', 'search_code', 'run_tests'],
  guardrails: {
    maxTokens: 200_000,
    maxCostCents: 100,
    maxIterations: 30,
  },
  tags: ['migration', 'framework', 'upgrade', 'refactor'],
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** All built-in agent templates, keyed by template ID. */
export const AGENT_TEMPLATES: Readonly<Record<string, AgentTemplate>> = {
  'code-reviewer': codeReviewer,
  'data-analyst': dataAnalyst,
  'devops-agent': devopsAgent,
  'security-auditor': securityAuditor,
  'documentation-agent': documentationAgent,
  'migration-agent': migrationAgent,
} as const

/**
 * Get a template by ID.
 *
 * @param id - The template identifier (e.g. `'code-reviewer'`).
 * @returns The matching `AgentTemplate`, or `undefined` if not found.
 */
export function getAgentTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES[id]
}

/**
 * List all available template IDs.
 *
 * @returns An array of template identifier strings.
 */
export function listAgentTemplates(): string[] {
  return Object.keys(AGENT_TEMPLATES)
}
