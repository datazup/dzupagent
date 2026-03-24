/**
 * Default tool risk tier mappings.
 *
 * These constants define the built-in classification of tools into
 * three risk tiers: auto-approve, log, and require-approval.
 */

/** Safe read-only operations — always auto-approved. */
export const DEFAULT_AUTO_APPROVE_TOOLS: readonly string[] = [
  'read_file',
  'list_files',
  'search_files',
  'search_code',
  'git_status',
  'git_diff',
  'git_log',
  'get_repo',
  'list_issues',
  'list_prs',
  'db_schema',
  'validate',
  'get_file',
] as const

/** Write operations — proceed but log for audit trail. */
export const DEFAULT_LOG_TOOLS: readonly string[] = [
  'write_file',
  'edit_file',
  'multi_edit',
  'generate_file',
  'git_commit',
  'git_branch',
  'create_issue',
  'send_message',
  'http_request',
] as const

/** Destructive operations — require explicit human approval. */
export const DEFAULT_REQUIRE_APPROVAL_TOOLS: readonly string[] = [
  'delete_file',
  'git_push',
  'git_force_push',
  'execute_command',
  'run_shell',
  'db_query',
  'create_pr',
  'merge_pr',
  'drop_table',
] as const
