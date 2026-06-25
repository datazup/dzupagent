/**
 * Re-exports from @dzupagent/core where this guard now lives.
 * Kept here for backward compatibility with existing agent-adapters consumers.
 */
export {
  SHELL_TOOL_NAMES,
  DESTRUCTIVE_COMMAND_PATTERNS,
  assertCommandNotDestructive,
} from "@dzupagent/core/security";
