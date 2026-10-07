import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolveWorkspaceSiblingUrl(...segments: string[]): URL {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const commonGitDirectory = resolve(
    testDirectory,
    execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: testDirectory,
      encoding: "utf8",
    }).trim(),
  );
  const workspaceRoot = process.env.DATAZUP_AUDIT_WORKSPACE_ROOT ?? dirname(dirname(commonGitDirectory));
  if (!isAbsolute(workspaceRoot)) throw new Error("DATAZUP_AUDIT_WORKSPACE_ROOT must be absolute");
  if (!existsSync(resolve(workspaceRoot, "scripts/package.json"))) {
    throw new Error("Required workspace siblings missing; set DATAZUP_AUDIT_WORKSPACE_ROOT to a source-pinned workspace");
  }

  return pathToFileURL(resolve(workspaceRoot, ...segments));
}
