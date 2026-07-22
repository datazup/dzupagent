import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

/**
 * Reader/validator for the operator-approved Codex base-profile directory
 * (cliBaseProfileRoot). Extracted from the adapter class because it is a
 * self-contained filesystem concern: it enumerates the approved profile files,
 * hardens each against path escape / non-regular-file / symlink attacks, and
 * reads the approved config.toml under a realpath-contained root. The functions
 * are pure over the two config fields they need, so they carry no adapter state.
 */

const DEFAULT_BASE_PROFILE_FILES = [
  "auth.json",
  "config.toml",
  "installation_id",
  "version.json",
] as const;

/** Resolve the approved base-profile file list, applying the default set. */
function resolveBaseProfileFiles(
  files: readonly string[] | undefined
): readonly string[] {
  return files ?? DEFAULT_BASE_PROFILE_FILES;
}

/**
 * Enumerate the approved base-profile files as CLI-home copy inputs, skipping
 * `excluded` targets and any missing source file, and rejecting path-escape or
 * non-regular-file entries.
 */
export async function buildBaseProfileInputs(
  root: string | undefined,
  files: readonly string[] | undefined,
  excluded: ReadonlySet<string>
): Promise<Record<string, { sourcePath: string; targetPath: string }>> {
  if (!root) return {};
  const resolved = resolveBaseProfileFiles(files);
  const inputs: Record<string, { sourcePath: string; targetPath: string }> = {};
  for (const [index, relativePath] of resolved.entries()) {
    if (excluded.has(relativePath)) continue;
    if (
      !relativePath ||
      relativePath.startsWith("/") ||
      relativePath.split(/[\\/]/u).includes("..")
    ) {
      throw new Error(
        `Codex base-profile file must be a contained relative path: ${relativePath}`
      );
    }
    const sourcePath = join(root, relativePath);
    const info = await stat(sourcePath).catch(() => null);
    if (!info) continue;
    if (!info.isFile())
      throw new Error(
        `Codex base-profile input must be a regular file: ${sourcePath}`
      );
    inputs[`baseProfile${index}`] = { sourcePath, targetPath: relativePath };
  }
  return inputs;
}

/**
 * Read the approved config.toml contents (empty string when absent), enforcing
 * that the resolved path stays under the realpath-contained approved root, is a
 * regular file, and does not exceed 1 MiB.
 */
export async function readApprovedBaseConfig(
  root: string | undefined,
  files: readonly string[] | undefined
): Promise<string> {
  const resolved = resolveBaseProfileFiles(files);
  if (!root || !resolved.includes("config.toml")) return "";
  const approvedRoot = await realpath(root);
  const configPath = await realpath(join(approvedRoot, "config.toml")).catch(
    () => null
  );
  if (!configPath) return "";
  const fromRoot = relative(approvedRoot, configPath);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(
      "Codex base config must remain under the approved profile root"
    );
  }
  const info = await stat(configPath);
  if (!info.isFile())
    throw new Error("Codex base config must be a regular file");
  if (info.size > 1024 * 1024)
    throw new Error("Codex base config exceeds 1 MiB");
  return readFile(configPath, "utf8");
}
