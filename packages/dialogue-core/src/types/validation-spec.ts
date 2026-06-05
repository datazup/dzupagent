export type SandboxPolicy = "none" | "read-only" | "workspace-write";

export interface ValidationSpec {
  commandId: string;
  args?: string[];
  cwdRoot: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  tenantScope?: string;
  sandboxPolicy?: SandboxPolicy;
}
