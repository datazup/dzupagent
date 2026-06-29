import { ForgeError } from "../errors/forge-error.js";

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
  /* eslint-disable security/detect-unsafe-regex */
  {
    pattern:
      /\brm\s+(?:(?:--recursive|--force|-[a-zA-Z]+)\s+)*\/[/.]?\*?(\s|$)/i,
    label: "root filesystem wipe (rm -rf /)",
  },
  {
    pattern: /\bcurl\b.*\|\s*(sh|bash|zsh|fish|ksh|dash)\b/i,
    label: "remote code execution via curl pipe",
  },
  {
    pattern: /\bwget\b.*\|\s*(sh|bash|zsh|fish|ksh|dash)\b/i,
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
  /* eslint-enable security/detect-unsafe-regex */
];

/** Recognized input key names that carry the command string. */
const COMMAND_INPUT_KEYS = ["command", "cmd", "code", "input"] as const;

/**
 * Assert that a tool call does not invoke a destructive shell command.
 *
 * Only inspects tools listed in {@link SHELL_TOOL_NAMES} or in `extraShellToolNames`.
 * For those, extracts the command string from known input keys and checks it against
 * {@link DESTRUCTIVE_COMMAND_PATTERNS}.
 *
 * @param extraShellToolNames - Additional MCP shell tool names to inspect beyond
 *   the built-in {@link SHELL_TOOL_NAMES} set. Used when an operator registers a
 *   custom MCP shell server with a non-standard tool name (e.g. "execute", "terminal").
 *
 * @throws ForgeError with code `DESTRUCTIVE_COMMAND_BLOCKED` on match.
 */
export function assertCommandNotDestructive(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  extraShellToolNames?: readonly string[]
): void {
  const isShellTool =
    SHELL_TOOL_NAMES.has(toolName) ||
    (extraShellToolNames !== undefined &&
      extraShellToolNames.includes(toolName));
  if (!isShellTool) return;
  if (input === null || input === undefined || typeof input !== "object")
    return;

  for (const key of COMMAND_INPUT_KEYS) {
    const value = input[key];
    if (typeof value !== "string") continue;
    for (const { pattern, label } of DESTRUCTIVE_COMMAND_PATTERNS) {
      if (pattern.test(value)) {
        throw new ForgeError({
          code: "DESTRUCTIVE_COMMAND_BLOCKED",
          message: `DESTRUCTIVE_COMMAND_BLOCKED: ${label}`,
          recoverable: false,
          context: { toolName, pattern: label },
        });
      }
    }
  }
}
