import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { CliHomeProjection } from "../../cli-runtime/index.js";
import { policyRejected } from "./policy.js";

/**
 * Crash-recovery variant of the Codex CODEX_HOME projection: instead of a
 * throwaway temp directory, thread state is materialized under a private
 * `.dzupagent-codex-home` inside the worker-owned working directory so a
 * restarting worker can resume the session. Extracted from the adapter class
 * because it is a self-contained filesystem subsystem (O_NOFOLLOW private-file
 * writes + symlink-hardened directory checks) with no dependency on adapter state.
 */
export async function createPersistentCodexHome(
  workingDirectory: string | undefined,
  baseProfileInputs: Readonly<
    Record<string, { sourcePath: string; targetPath: string }>
  >,
  generatedFiles: Readonly<
    Record<string, { path: string; content: string; mode?: number }>
  >
): Promise<CliHomeProjection> {
  if (!workingDirectory || !isAbsolute(workingDirectory)) {
    throw policyRejected(
      "Persistent Codex sessions require an absolute worker-owned working directory",
      "missing_working_directory"
    );
  }
  const realWorkingDirectory = await realpath(workingDirectory);
  const root = join(realWorkingDirectory, ".dzupagent-codex-home");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(root);

  const requiredDirectories: string[] = [];
  for (const relativePath of ["sessions", "mcp"]) {
    const target = join(root, relativePath);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await requirePrivateDirectory(target);
    requiredDirectories.push(target);
  }

  const baseProfilePaths: Record<string, string> = {};
  for (const [id, input] of Object.entries(baseProfileInputs)) {
    const target = join(root, input.targetPath);
    await writePrivateRegularFile(target, await readFile(input.sourcePath));
    baseProfilePaths[id] = target;
  }

  const generatedPaths: Record<string, string> = {};
  for (const [id, file] of Object.entries(generatedFiles)) {
    const target = join(root, file.path);
    await writePrivateRegularFile(target, file.content);
    generatedPaths[id] = target;
  }

  return {
    root,
    env: Object.freeze({ CODEX_HOME: root }),
    generatedPaths: Object.freeze(generatedPaths),
    baseProfilePaths: Object.freeze(baseProfilePaths),
    requiredDirectories: Object.freeze(requiredDirectories),
    cleanup: async () => undefined,
  };
}

async function requirePrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw policyRejected(
      "Persistent Codex session path must be a private directory",
      "unsafe_session_home"
    );
  }
}

async function writePrivateRegularFile(
  path: string,
  content: string | Buffer
): Promise<void> {
  const existing = await lstat(path).catch(() => null);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw policyRejected(
      "Persistent Codex session file must be regular",
      "unsafe_session_home"
    );
  }
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}
