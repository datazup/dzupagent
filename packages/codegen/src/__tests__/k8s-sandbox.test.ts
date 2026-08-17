import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

import type {
  AgentSandboxResource,
  AgentSandboxSpec,
} from "../sandbox/k8s/operator-types.js";
import { createAgentSandboxResource } from "../sandbox/k8s/operator-types.js";
import { K8sClient } from "../sandbox/k8s/k8s-client.js";
import { K8sPodSandbox } from "../sandbox/k8s/k8s-sandbox.js";

// ===========================================================================
// Test helpers
// ===========================================================================

function makeSandbox(
  overrides?: Partial<AgentSandboxSpec>
): AgentSandboxResource {
  return createAgentSandboxResource(
    "test-sandbox",
    {
      image: "node:20-slim",
      ...overrides,
    },
    "test-ns"
  );
}

function makeReadySandbox(
  overrides?: Partial<AgentSandboxSpec>
): AgentSandboxResource {
  const sb = makeSandbox(overrides);
  sb.status = {
    phase: "Ready",
    podName: "test-sandbox",
    startedAt: new Date().toISOString(),
  };
  return sb;
}

/**
 * Create a mock fetch that returns pre-configured responses.
 * Each call pops the next response from the queue.
 */
function mockFetch(
  responses: Array<{ ok: boolean; status: number; body: unknown }>
): typeof globalThis.fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const resp = queue.shift();
    if (!resp) {
      throw new Error("No more mock responses");
    }
    return {
      ok: resp.ok,
      status: resp.status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    } as Response;
  });
}

// ===========================================================================
// AgentSandboxResource types
// ===========================================================================

describe("AgentSandboxResource types", () => {
  it("createAgentSandboxResource produces valid resource", () => {
    const resource = createAgentSandboxResource("my-sandbox", {
      image: "node:20-slim",
    });

    expect(resource.apiVersion).toBe("dzupagent.dev/v1alpha1");
    expect(resource.kind).toBe("AgentSandbox");
    expect(resource.metadata.name).toBe("my-sandbox");
    expect(resource.spec.image).toBe("node:20-slim");
    expect(resource.spec.securityLevel).toBe("default");
    expect(resource.spec.resources.limits.cpu).toBe("1");
    expect(resource.spec.resources.limits.memory).toBe("512Mi");
    expect(resource.spec.network.egressPolicy).toBe("deny-all");
  });

  it("createAgentSandboxResource applies namespace", () => {
    const resource = createAgentSandboxResource(
      "sb",
      { image: "alpine" },
      "custom-ns"
    );
    expect(resource.metadata.namespace).toBe("custom-ns");
  });

  it("createAgentSandboxResource applies spec overrides", () => {
    const resource = createAgentSandboxResource("sb", {
      image: "python:3.12",
      securityLevel: "strict",
      ttlSeconds: 300,
      network: { egressPolicy: "allow-all" },
      resources: { limits: { cpu: "2", memory: "1Gi" } },
    });

    expect(resource.spec.image).toBe("python:3.12");
    expect(resource.spec.securityLevel).toBe("strict");
    expect(resource.spec.ttlSeconds).toBe(300);
    expect(resource.spec.network.egressPolicy).toBe("allow-all");
    expect(resource.spec.resources.limits.memory).toBe("1Gi");
  });

  it("resource has correct managed-by label", () => {
    const resource = createAgentSandboxResource("sb", { image: "alpine" });
    expect(resource.metadata.labels?.["app.kubernetes.io/managed-by"]).toBe(
      "dzupagent"
    );
  });
});

// ===========================================================================
// K8sClient
// ===========================================================================

describe("K8sClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("createResource sends POST and returns the created resource", async () => {
    const resource = makeSandbox();
    const createdResource = {
      ...resource,
      metadata: { ...resource.metadata, uid: "abc-123" },
    };

    globalThis.fetch = mockFetch([
      { ok: true, status: 201, body: createdResource },
    ]);

    const client = new K8sClient({
      apiServerUrl: "http://localhost:8080",
      token: "test-token",
    });
    const result = await client.createResource(resource);

    expect(result.metadata.uid).toBe("abc-123");
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(callArgs[0]).toContain(
      "/apis/dzupagent.dev/v1alpha1/namespaces/test-ns/agentsandboxes"
    );
    expect(callArgs[1]?.method).toBe("POST");
  });

  it("getResource returns resource for 200", async () => {
    const resource = makeSandbox();
    globalThis.fetch = mockFetch([{ ok: true, status: 200, body: resource }]);

    const client = new K8sClient({
      apiServerUrl: "http://localhost:8080",
      token: "test-token",
    });
    const result = await client.getResource("test-sandbox", "test-ns");

    expect(result).toBeDefined();
    expect(result?.metadata.name).toBe("test-sandbox");
  });

  it("getResource returns undefined for 404", async () => {
    globalThis.fetch = mockFetch([
      { ok: false, status: 404, body: { message: "not found" } },
    ]);

    const client = new K8sClient({
      apiServerUrl: "http://localhost:8080",
      token: "test-token",
    });
    const result = await client.getResource("missing", "test-ns");

    expect(result).toBeUndefined();
  });

  it("deleteResource sends DELETE", async () => {
    globalThis.fetch = mockFetch([{ ok: true, status: 200, body: {} }]);

    const client = new K8sClient({
      apiServerUrl: "http://localhost:8080",
      token: "test-token",
    });
    await client.deleteResource("test-sandbox", "test-ns");

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(callArgs[1]?.method).toBe("DELETE");
  });

  it("deleteResource does not throw for 404", async () => {
    globalThis.fetch = mockFetch([
      { ok: false, status: 404, body: { message: "not found" } },
    ]);

    const client = new K8sClient({
      apiServerUrl: "http://localhost:8080",
      token: "test-token",
    });
    await expect(
      client.deleteResource("test-sandbox", "test-ns")
    ).resolves.toBeUndefined();
  });

  it("createResource throws on non-ok response", async () => {
    globalThis.fetch = mockFetch([
      { ok: false, status: 500, body: { message: "internal error" } },
    ]);

    const client = new K8sClient({
      apiServerUrl: "http://localhost:8080",
      token: "test-token",
    });
    await expect(client.createResource(makeSandbox())).rejects.toThrow(
      "K8s createResource failed (500)"
    );
  });

  it("uses default namespace when none specified", async () => {
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, body: makeSandbox() },
    ]);

    const client = new K8sClient({
      apiServerUrl: "http://localhost:8080",
      token: "test-token",
    });
    await client.getResource("test-sandbox");

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(callArgs[0]).toContain("/namespaces/default/");
  });

  it("includes Authorization header when token is set", async () => {
    globalThis.fetch = mockFetch([
      { ok: true, status: 200, body: makeSandbox() },
    ]);

    const client = new K8sClient({
      apiServerUrl: "http://localhost:8080",
      token: "my-token",
    });
    await client.getResource("test-sandbox");

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0]!;
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-token");
  });
});

// ===========================================================================
// K8sPodSandbox
// ===========================================================================

describe("K8sPodSandbox", () => {
  it("execute delegates to K8sClient.exec", async () => {
    const execMock = vi.fn().mockResolvedValue({
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    });

    const client = {
      createResource: vi.fn().mockResolvedValue(makeSandbox()),
      getResource: vi.fn().mockResolvedValue(undefined),
      deleteResource: vi.fn().mockResolvedValue(undefined),
      waitForPhase: vi.fn().mockResolvedValue(makeReadySandbox()),
      exec: execMock,
      updateStatus: vi.fn(),
    } as unknown as K8sClient;

    const sandbox = new K8sPodSandbox({
      k8sClient: client,
      namespace: "test-ns",
    });
    const result = await sandbox.execute("echo hello");

    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(execMock).toHaveBeenCalledWith(
      "test-sandbox",
      ["sh", "-c", "echo hello"],
      "test-ns"
    );
  });

  it("cleanup deletes the CRD resource", async () => {
    const deleteResourceMock = vi.fn().mockResolvedValue(undefined);

    const client = {
      createResource: vi.fn().mockResolvedValue(makeSandbox()),
      getResource: vi.fn().mockResolvedValue(undefined),
      deleteResource: deleteResourceMock,
      waitForPhase: vi.fn().mockResolvedValue(makeReadySandbox()),
      exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      updateStatus: vi.fn(),
    } as unknown as K8sClient;

    const sandbox = new K8sPodSandbox({
      k8sClient: client,
      namespace: "test-ns",
    });

    // Execute something first to create the pod
    await sandbox.execute("echo test");
    await sandbox.cleanup();

    expect(deleteResourceMock).toHaveBeenCalledOnce();
  });

  it("downloadFiles returns empty when no pod exists", async () => {
    const client = {
      createResource: vi.fn(),
      getResource: vi.fn(),
      deleteResource: vi.fn(),
      waitForPhase: vi.fn(),
      exec: vi.fn(),
      updateStatus: vi.fn(),
    } as unknown as K8sClient;

    const sandbox = new K8sPodSandbox({ k8sClient: client });
    const files = await sandbox.downloadFiles(["/some/file.ts"]);

    expect(files).toEqual({});
  });
});

// ===========================================================================
// SEC-H-04: shell-injection safety (model-controlled path / cwd)
// ===========================================================================

describe("K8sPodSandbox shell-injection safety (SEC-H-04)", () => {
  function makeClient(): {
    client: K8sClient;
    execMock: ReturnType<typeof vi.fn>;
  } {
    const execMock = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const client = {
      createResource: vi.fn().mockResolvedValue(makeSandbox()),
      getResource: vi.fn().mockResolvedValue(undefined),
      deleteResource: vi.fn().mockResolvedValue(undefined),
      waitForPhase: vi.fn().mockResolvedValue(makeReadySandbox()),
      exec: execMock,
      updateStatus: vi.fn(),
    } as unknown as K8sClient;
    return { client, execMock };
  }

  // A payload that, if interpolated raw into an `sh -c` string, breaks out of
  // the single quotes and runs `touch /pwned`.
  const INJECTION = "x'; touch /pwned; echo '";

  it("uploadFiles passes the model-chosen path as a positional arg, never in the script text", async () => {
    const { client, execMock } = makeClient();
    const sandbox = new K8sPodSandbox({
      k8sClient: client,
      namespace: "test-ns",
    });

    await sandbox.uploadFiles({ [INJECTION]: "content" });

    expect(execMock).toHaveBeenCalledOnce();
    const argv = execMock.mock.calls[0]![1] as string[];
    // argv[2] is the constant script text — it must be fixed and must NOT
    // contain the attacker payload.
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
    expect(argv[2]).not.toContain("touch /pwned");
    expect(argv[2]).not.toContain(INJECTION);
    // The path is passed as data ($1), so it appears verbatim as its own argv
    // element — proof it is not part of the executable script text.
    expect(argv).toContain(INJECTION);
  });

  it("execute passes a model-chosen cwd as a positional arg, never in the script text", async () => {
    const { client, execMock } = makeClient();
    const sandbox = new K8sPodSandbox({
      k8sClient: client,
      namespace: "test-ns",
    });

    await sandbox.execute("echo safe", { cwd: INJECTION });

    expect(execMock).toHaveBeenCalledOnce();
    const argv = execMock.mock.calls[0]![1] as string[];
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
    // The script element must not embed the injected cwd.
    expect(argv[2]).not.toContain("touch /pwned");
    expect(argv[2]).not.toContain(INJECTION);
    // cwd travels as a positional argument, not as code.
    expect(argv).toContain(INJECTION);
  });

  it("execute with the default cwd still runs the command directly", async () => {
    const { client, execMock } = makeClient();
    const sandbox = new K8sPodSandbox({
      k8sClient: client,
      namespace: "test-ns",
    });

    await sandbox.execute("echo hello");

    expect(execMock).toHaveBeenCalledWith(
      "test-sandbox",
      ["sh", "-c", "echo hello"],
      "test-ns"
    );
  });
});

// ===========================================================================
// Import/export check: verify barrel re-exports compile
// ===========================================================================

describe("K8s barrel exports", () => {
  it("exports all expected symbols from index", async () => {
    const k8sModule = await import("../sandbox/k8s/index.js");

    expect(k8sModule.K8sClient).toBeDefined();
    expect(k8sModule.K8sPodSandbox).toBeDefined();
    expect(k8sModule.createAgentSandboxResource).toBeDefined();
  });
});
