import { ForgeError } from "../errors/forge-error.js";

/** Environment variables that must never be overridden by MCP server config */
const BLOCKED_ENV_VARS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_DEBUG",
  "ELECTRON_RUN_AS_NODE",
  "PATH",
]);

/** Characters that should not appear in executable paths */
const UNSAFE_PATH_CHARS = /[;&|`$(){}[\]<>!#~]/;

/**
 * Validate an MCP server executable path.
 * Blocks paths with shell metacharacters and relative traversals.
 */
export function validateMcpExecutablePath(path: string): void {
  if (!path || path.trim().length === 0) {
    throw new ForgeError({
      code: "MCP_CONNECTION_FAILED",
      message: "MCP server executable path is empty",
      recoverable: false,
    });
  }

  if (UNSAFE_PATH_CHARS.test(path)) {
    throw new ForgeError({
      code: "MCP_CONNECTION_FAILED",
      message: `MCP server executable path contains unsafe characters: ${path}`,
      recoverable: false,
      context: { path },
    });
  }

  // Block obvious traversal attempts
  if (path.includes("..")) {
    throw new ForgeError({
      code: "MCP_CONNECTION_FAILED",
      message: `MCP server executable path contains directory traversal: ${path}`,
      recoverable: false,
      context: { path },
    });
  }
}

/**
 * Policy controlling how stdio MCP command arguments are validated.
 *
 * - `'strict'` (default): reject known interpreter binaries (node, bash,
 *   python, npx, …) when their arguments contain an eval/inline-script flag
 *   or an arbitrary package-execution form. This blocks host RCE such as
 *   `node -e '<payload>'` or `bash -c '<payload>'` even when the executable
 *   itself is on the allowlist.
 * - `'legacy'`: preserve pre-hardening behaviour — only the executable path
 *   is validated, arguments are not inspected. This MUST be an explicit
 *   opt-in for back-compat with trusted, pre-existing configs.
 */
export type McpStdioArgPolicy = "strict" | "legacy";

/**
 * Maps an interpreter basename to the set of argument tokens that cause it to
 * execute an inline script / arbitrary package. Matching is exact on a
 * normalised argument token (anything up to a `=`, e.g. `--eval=foo` matches
 * `--eval`). The basename is matched after stripping directories and a
 * trailing `.exe`/`.cmd` suffix, so `/usr/bin/node` === `node` === `node.exe`.
 *
 * The detection is intentionally conservative: we only flag the well-known
 * code-execution flags so that legitimate launches (`node ./server.js`,
 * `python -m my_server`) keep working.
 */
const INTERPRETER_EVAL_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  // Node: -e/--eval run a string; -p/--print evals then prints; --input-type
  // forces inline module evaluation of stdin/argument source.
  node: new Set(["-e", "--eval", "-p", "--print", "--input-type"]),
  nodejs: new Set(["-e", "--eval", "-p", "--print", "--input-type"]),
  // Bun: -e/--eval/eval all run inline source.
  bun: new Set(["-e", "--eval", "eval"]),
  // Deno: `eval` subcommand runs inline source; `run -` reads the program
  // from stdin (equivalent to inline execution).
  deno: new Set(["eval"]),
  // Python: -c runs an inline program.
  python: new Set(["-c"]),
  python3: new Set(["-c"]),
  // POSIX shells: -c runs an inline command string.
  bash: new Set(["-c"]),
  sh: new Set(["-c"]),
  zsh: new Set(["-c"]),
  dash: new Set(["-c"]),
  ksh: new Set(["-c"]),
  // Ruby / Perl: -e (and Perl's -E) run inline source.
  ruby: new Set(["-e"]),
  perl: new Set(["-e", "-E"]),
};

/**
 * Package-runner basenames. ANY invocation with a package argument executes
 * arbitrary code fetched from a registry, so these are treated as inline
 * execution whenever they are given a non-flag package argument.
 */
const PACKAGE_RUNNER_BASENAMES: ReadonlySet<string> = new Set([
  "npx",
  "pnpx",
  "bunx",
  "dlx", // `pnpm dlx` / `yarn dlx` collapse to the `dlx` first token in some shells
]);

/**
 * Package managers whose `dlx` subcommand fetches+executes arbitrary packages
 * (e.g. `pnpm dlx <pkg>`, `yarn dlx <pkg>`).
 */
const PACKAGE_MANAGER_BASENAMES: ReadonlySet<string> = new Set([
  "pnpm",
  "yarn",
]);

/** Strip directory components and a trailing .exe/.cmd from a command path. */
function commandBasename(command: string): string {
  // Normalise both separators so Windows-style paths resolve too.
  const lastSep = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  const base = lastSep >= 0 ? command.slice(lastSep + 1) : command;
  return base.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

/** Normalise an argument token to the part before an `=` (for `--eval=…`). */
function normaliseArgToken(arg: string): string {
  const eq = arg.indexOf("=");
  return (eq >= 0 ? arg.slice(0, eq) : arg).toLowerCase();
}

/** Is this token a flag (starts with `-`)? Used to detect package arguments. */
function isFlagToken(arg: string): boolean {
  return arg.startsWith("-");
}

/**
 * Assert that a stdio MCP command + argument vector is permitted to launch.
 *
 * Under the default `'strict'` policy this rejects host-RCE forms where an
 * allowlisted interpreter is driven into executing inline source or an
 * arbitrary package, e.g. `node -e <payload>`, `bash -c <payload>`,
 * `python -c <payload>`, `npx <pkg>`, `deno eval <payload>`, `bun -e <payload>`.
 *
 * The error message deliberately does NOT echo the payload verbatim — it
 * names the interpreter and the offending flag class so an admin can fix the
 * config without the message itself becoming an exploitation aid.
 *
 * @throws ForgeError with code `MCP_COMMAND_FORBIDDEN` when rejected.
 */
export function assertMcpCommandAllowed(
  command: string,
  args: readonly string[] | undefined,
  policy: McpStdioArgPolicy = "strict"
): void {
  if (policy === "legacy") return;
  if (!args || args.length === 0) return;

  const basename = commandBasename(command);
  const tokens = args.map(normaliseArgToken);

  // 1) Direct interpreter eval/inline flags.
  const evalFlags = INTERPRETER_EVAL_FLAGS[basename];
  if (evalFlags) {
    for (const token of tokens) {
      if (evalFlags.has(token)) {
        throwForbidden(basename, `inline-eval flag '${token}'`);
      }
    }
    // Deno's `run -` reads the program from stdin (inline execution).
    if (basename === "deno" && tokens[0] === "run" && args.includes("-")) {
      throwForbidden(basename, "stdin program via 'run -'");
    }
  }

  // 2) Direct package runners (npx/pnpx/bunx/…): any package argument runs code.
  if (PACKAGE_RUNNER_BASENAMES.has(basename)) {
    if (args.some((a) => !isFlagToken(a))) {
      throwForbidden(basename, "arbitrary package execution");
    }
  }

  // 3) Package managers with a `dlx` subcommand (pnpm dlx / yarn dlx).
  if (PACKAGE_MANAGER_BASENAMES.has(basename) && tokens[0] === "dlx") {
    throwForbidden(basename, "arbitrary package execution via 'dlx'");
  }
}

/** Throw a uniform forbidden error without echoing the payload. */
function throwForbidden(basename: string, reason: string): never {
  throw new ForgeError({
    code: "MCP_COMMAND_FORBIDDEN",
    message:
      `stdio MCP command rejected: interpreter '${basename}' was invoked with ` +
      `${reason}, which permits arbitrary host code execution.`,
    recoverable: false,
    suggestion:
      "Point the MCP server at a launcher script (e.g. `node ./server.js`) instead " +
      'of an inline-eval invocation, or set mcpStdioArgPolicy to "legacy" only for ' +
      "fully trusted configs.",
    context: { interpreter: basename },
  });
}

/**
 * Sanitize environment variables for MCP child processes.
 * Removes dangerous variables that could be used for code injection.
 */
export function sanitizeMcpEnv(
  baseEnv: Record<string, string | undefined>,
  serverEnv?: Record<string, string>
): Record<string, string | undefined> {
  const result = { ...baseEnv };

  if (serverEnv) {
    for (const [key, value] of Object.entries(serverEnv)) {
      if (BLOCKED_ENV_VARS.has(key.toUpperCase())) {
        // Silently skip blocked vars — don't throw, just don't apply
        continue;
      }
      result[key] = value;
    }
  }

  return result;
}
