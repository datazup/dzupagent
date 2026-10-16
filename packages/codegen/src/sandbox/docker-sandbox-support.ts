/**
 * DockerSandbox support helpers: the isolation flag matrix shared by one-shot
 * runs and long-lived sessions (SEC-M-57), the session env-file writer, and
 * container kill/remove used on timeout (SEC-M-56). Internal to the sandbox
 * module; not part of the package's public surface.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DockerIsolationOptions {
  memoryLimit: string;
  cpuLimit: string;
  previewMode: boolean;
  /** Host upload dir mounted at /work. */
  uploadDir: string | null;
}

/** Best-effort `docker kill <name>`; the container may already be gone. */
export async function killDockerContainer(name: string): Promise<void> {
  try {
    await execFileAsync("docker", ["kill", name], { timeout: 15_000 });
  } catch {
    // Container may already have exited
  }
}

/** Kill and force-remove a one-shot container after its client was killed. */
export async function forceRemoveDockerContainer(name: string): Promise<void> {
  await killDockerContainer(name);
  try {
    await execFileAsync("docker", ["rm", "-f", name], { timeout: 10_000 });
  } catch {
    // `--rm` may already have removed it
  }
}

/**
 * Write session env vars to a mode-0600 env file inside a private temp dir
 * (never the mounted upload dir) so values stay off the docker argv, where
 * any local user could read them via `ps`. Returns the dir, or undefined
 * when there is nothing to pass.
 */
export async function writeDockerEnvFile(
  envVars?: Record<string, string>
): Promise<string | undefined> {
  const entries = Object.entries(envVars ?? {});
  if (entries.length === 0) return undefined;
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid sandbox env var name: "${key}"`);
    }
    if (/[\r\n\0]/.test(value)) {
      throw new Error(
        `Sandbox env var "${key}" contains a newline or NUL, which an env file cannot carry`
      );
    }
    lines.push(`${key}=${value}`);
  }
  const dir = await mkdtemp(join(tmpdir(), "forge-sandbox-env-"));
  try {
    await writeFile(join(dir, "session.env"), lines.join("\n") + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

/**
 * Isolation flags shared by one-shot runs and long-lived sessions, so the
 * two paths cannot drift apart (SEC-M-57).
 *
 * In preview mode: allow network, read-write workspace mount.
 * In secure mode (default), the locked-down flag matrix is:
 *   --network=none          no outbound network
 *   --pull=never            never pull an image implicitly
 *   --read-only             container filesystem is read-only
 *   --cap-drop=ALL          no Linux capabilities
 *   --user=<uid>:<gid>      not container root
 *   --tmpfs=/tmp            writable temp only (size-capped)
 *   -v <upload>:/work:ro    the single /work mount
 *   --security-opt=no-new-privileges   no privilege escalation
 */
export function buildDockerIsolationArgs(opts: DockerIsolationOptions): string[] {
  const args = [
    "--init",
    `--memory=${opts.memoryLimit}`,
    `--cpus=${opts.cpuLimit}`,
    "--security-opt=no-new-privileges",
    "--stop-timeout=5",
  ];

  if (opts.previewMode) {
    // Preview mode: allow network and read-write workspace
    args.push("--tmpfs=/tmp:size=100m", "-v", `${opts.uploadDir}:/work`);
  } else {
    // Secure mode (default): locked-down
    args.push(
      "--network=none",
      "--pull=never",
      "--read-only",
      "--cap-drop=ALL",
      // With DAC capabilities dropped, container root cannot read a host
      // mkdtemp directory (0700). Preserve its owner's access, without
      // widening host permissions or restoring container capabilities.
      `--user=${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--tmpfs=/tmp:size=100m",
      "-v",
      `${opts.uploadDir}:/work:ro`
    );
  }
  return args;
}
