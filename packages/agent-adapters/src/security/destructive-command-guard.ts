import { ForgeError } from "@dzupagent/core";

/**
 * Shell/bash tool names whose command arguments are inspected for
 * destructive patterns before the tool call is allowed to execute.
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "execute_command",
  "run_shell",
  "run_command",
  "shell",
]);

/**
 * Destructive command patterns matched against the command string before a
 * shell tool is allowed to execute. Conservative: only patterns with no
 * legitimate autonomous-agent use.
 */
export const DESTRUCTIVE_COMMAND_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
  {
    pattern: /\brm\s+(?:(?:--recursive|--force|-[a-zA-Z]+)\s+)*\/\*?(\s|$)/i,
    label: "root filesystem wipe (rm -rf /)",
  },
  {
    pattern: /\brm\s+(?:(?:--recursive|--force|-[a-zA-Z]+)\s+)*\/\*?(\s|$)/i,
    label: "root filesystem wipe (rm -r -f / or long flags)",
  },
  {
    pattern: /\bcurl\b.*\|\s*(sh|bash)\b/i,
    label: "remote code execution via curl pipe",
  },
  {
    pattern: /\bwget\b.*\|\s*(sh|bash)\b/i,
    label: "remote code execution via wget pipe",
  },
  {
    pattern: /:\(\)\s*\{\s*:\|:&?\s*\}\s*;:/,
    label: "fork bomb",
  },
  {
    pattern:
      /\bdd\b[^;]*\bof\s*=\s*\/dev\/(sd[a-z]|hd[a-z]|nvme\d+(?:n\d+(?:p\d+)?)?)\b/i,
    label: "disk destruction via dd",
  },
  {
    pattern: /\bmkfs\b[^;]*\/dev\/(sd[a-z]|hd[a-z]|nvme\d+(?:n\d+(?:p\d+)?)?)/i,
    label: "filesystem destruction via mkfs",
  },
];

/** Recognized input key names that carry the command string. */
const COMMAND_INPUT_KEYS = ["command", "cmd", "code", "input"] as const;

/**
 * Assert that a tool call does not invoke a destructive shell command.
 *
 * Only inspects tools listed in {@link SHELL_TOOL_NAMES}. For those,
 * extracts the command string from known input keys and checks it against
 * {@link DESTRUCTIVE_COMMAND_PATTERNS}.
 *
 * @throws ForgeError with code `DESTRUCTIVE_COMMAND_BLOCKED` on match.
 */
export function assertCommandNotDestructive(
  toolName: string,
  input: Record<string, unknown> | null | undefined
): void {
  if (!SHELL_TOOL_NAMES.has(toolName)) return;
  if (input === null || input === undefined || typeof input !== "object")
    return;

  for (const key of COMMAND_INPUT_KEYS) {
    const value = input[key];
    if (typeof value !== "string") continue;
    for (const { pattern, label } of DESTRUCTIVE_COMMAND_PATTERNS) {
      if (pattern.test(value)) {
        throw new ForgeError({
          code: "DESTRUCTIVE_COMMAND_BLOCKED",
          message: `Destructive shell command blocked: ${label}`,
          recoverable: false,
          context: { toolName, pattern: label },
        });
      }
    }
  }
}
