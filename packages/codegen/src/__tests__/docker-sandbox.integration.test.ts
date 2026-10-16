import { afterEach, describe, expect, it } from "vitest";
import { DockerSandbox } from "../sandbox/docker-sandbox.js";

// DZUPAGENT-SEC-L-33: the argv-mode command line is only proven against a real
// docker CLI — the unit suite mocks execFile. Opt in with
// DZUP_DOCKER_INTEGRATION=1 on a host with a local docker daemon and the image
// already pulled (the sandbox runs with --pull=never). Override the image with
// DZUP_DOCKER_INTEGRATION_IMAGE.
const enabled = process.env["DZUP_DOCKER_INTEGRATION"] === "1";
const image = process.env["DZUP_DOCKER_INTEGRATION_IMAGE"] ?? "node:20-slim";

describe.runIf(enabled)("DockerSandbox argv mode against real docker", () => {
  let sandbox: DockerSandbox | undefined;

  afterEach(async () => {
    await sandbox?.cleanup();
    sandbox = undefined;
  });

  it("runs argv[0] as the container command, not a '--' separator", async () => {
    sandbox = new DockerSandbox({ image, timeoutMs: 60_000 });
    const result = await sandbox.execute(["echo", "hi", "$(whoami)"]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi $(whoami)");
  });
});
