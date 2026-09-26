import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CliHomeProjection } from "../../cli-runtime/index.js";
import { policyRejected } from "./policy.js";

/**
 * Crash-recovery variant of the Codex CODEX_HOME projection: instead of a
 * throwaway temp directory, thread state is materialized in a private
 * directory that a restarting worker finds again for the same working
 * directory. Extracted from the adapter class because it is a self-contained
 * filesystem subsystem (O_NOFOLLOW private-file writes + symlink-hardened
 * directory checks) with no dependency on adapter state.
 *
 * With `homeRoot` (MVP-07-CP06FA) the home is
 * `<homeRoot>/<first 32 hex of sha256(realWorkingDirectory)>`, and a root
 * at or inside the working directory is refused: a coordinated attempt's
 * working directory is the pinned candidate checkout, so a home there would
 * join the candidate with its copied credentials. Without it the home stays
 * at `<workingDirectory>/.dzupagent-codex-home`.
 */
export async function createPersistentCodexHome(
  workingDirectory: string | undefined,
  baseProfileInputs: Readonly<
    Record<string, { sourcePath: string; targetPath: string }>
  >,
  generatedFiles: Readonly<
    Record<string, { path: string; content: string; mode?: number }>
  >,
  homeRoot?: string
): Promise<CliHomeProjection> {
  if (!workingDirectory || !isAbsolute(workingDirectory)) {
    throw policyRejected(
      "Persistent Codex sessions require an absolute worker-owned working directory",
      "missing_working_directory"
    );
  }
  const realWorkingDirectory = await realpath(workingDirectory);
  const root = homeRoot === undefined
    ? join(realWorkingDirectory, ".dzupagent-codex-home")
    : await rootedHome(workingDirectory, realWorkingDirectory, homeRoot);
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

async function rootedHome(
  workingDirectory: string,
  realWorkingDirectory: string,
  homeRoot: string
): Promise<string> {
  if (!isAbsolute(homeRoot)) {
    throw policyRejected(
      "Persistent Codex session home root must be absolute",
      "invalid_session_home_root"
    );
  }
  // Refused before anything is created, then again on the resolved path so a
  // symlinked root cannot lead back into the checkout.
  requireOutside(workingDirectory, resolve(homeRoot));
  requireOutside(realWorkingDirectory, resolve(homeRoot));
  await mkdir(homeRoot, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(homeRoot);
  const realHomeRoot = await realpath(homeRoot);
  requireOutside(realWorkingDirectory, realHomeRoot);
  const key = createHash("sha256")
    .update(realWorkingDirectory)
    .digest("hex")
    .slice(0, 32);
  return join(realHomeRoot, key);
}

function requireOutside(workingDirectory: string, homeRoot: string): void {
  const fromWorkingDirectory = relative(resolve(workingDirectory), homeRoot);
  if (
    fromWorkingDirectory === "" ||
    (fromWorkingDirectory !== ".." &&
      !fromWorkingDirectory.startsWith(`..${sep}`) &&
      !isAbsolute(fromWorkingDirectory))
  ) {
    throw policyRejected(
      "Persistent Codex session home root must be outside the working directory",
      "session_home_inside_working_directory"
    );
  }
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
