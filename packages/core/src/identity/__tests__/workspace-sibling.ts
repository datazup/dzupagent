import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolveWorkspaceSiblingUrl(...segments: string[]): URL {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = execFileSync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: testDirectory, encoding: "utf8" },
  ).trim();
  const commonGitDirectory = resolve(
    repositoryRoot,
    execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: testDirectory,
      encoding: "utf8",
    }).trim(),
  );
  const workspaceRoot = dirname(dirname(commonGitDirectory));

  return pathToFileURL(resolve(workspaceRoot, ...segments));
}
