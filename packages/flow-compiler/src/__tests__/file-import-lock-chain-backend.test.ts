import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableV2ImportLockChainStore,
  createV2ImportLockChainEntry,
} from "@dzupagent/flow-dsl";
import type { DslV2ImportLockChainEntry } from "@dzupagent/flow-dsl";
import { afterEach, describe, expect, it } from "vitest";

import { createFileV2ImportLockChainBackend } from "../file-import-lock-chain-backend.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dzup-import-lock-chain-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

/**
 * Build a genuine chain entry through the real factory rather than a
 * hand-rolled literal, so these tests exercise the same linking and digest
 * rules the store enforces at runtime.
 */
function entry(
  seed: string,
  parent?: DslV2ImportLockChainEntry
): DslV2ImportLockChainEntry {
  return createV2ImportLockChainEntry(
    {
      schema: "dzupagent.dslV2ResolvedImportLock/v1",
      catalogs: { primitives: [] },
      lockSha256: `sha256:${seed.repeat(64).slice(0, 64)}`,
    } as never,
    parent
  );
}

describe("createFileV2ImportLockChainBackend", () => {
  it("returns undefined for a flow with no stored chain", async () => {
    const backend = createFileV2ImportLockChainBackend({
      rootDirectory: await makeRoot(),
    });

    await expect(backend.read("unknown-flow")).resolves.toBeUndefined();
  });

  it("round-trips a document through the filesystem", async () => {
    const backend = createFileV2ImportLockChainBackend({
      rootDirectory: await makeRoot(),
    });

    await backend.write("flow-a", '{"hello":"world"}');

    await expect(backend.read("flow-a")).resolves.toBe('{"hello":"world"}');
  });

  it("keeps flows isolated from each other", async () => {
    const backend = createFileV2ImportLockChainBackend({
      rootDirectory: await makeRoot(),
    });

    await backend.write("flow-a", "first");
    await backend.write("flow-b", "second");

    await expect(backend.read("flow-a")).resolves.toBe("first");
    await expect(backend.read("flow-b")).resolves.toBe("second");
  });

  it("overwrites in place rather than appending a second record", async () => {
    const root = await makeRoot();
    const backend = createFileV2ImportLockChainBackend({ rootDirectory: root });

    await backend.write("flow-a", "first");
    await backend.write("flow-a", "second");

    await expect(backend.read("flow-a")).resolves.toBe("second");
    const remaining = await readdir(root);
    expect(remaining).toHaveLength(1);
  });

  // A flow id is author-supplied and reaches us as a path component. Without
  // this, `../../etc/whatever` would escape the root directory entirely.
  it("cannot be walked out of its root directory by a hostile flow id", async () => {
    const root = await makeRoot();
    const backend = createFileV2ImportLockChainBackend({ rootDirectory: root });

    await backend.write("../../escaped", "payload");

    const written = await readdir(root);
    expect(written).toHaveLength(1);
    await expect(backend.read("../../escaped")).resolves.toBe("payload");
  });

  it("distinguishes flow ids that would collide once path-sanitised", async () => {
    const backend = createFileV2ImportLockChainBackend({
      rootDirectory: await makeRoot(),
    });

    await backend.write("a/b", "slash");
    await backend.write("a:b", "colon");

    await expect(backend.read("a/b")).resolves.toBe("slash");
    await expect(backend.read("a:b")).resolves.toBe("colon");
  });

  it("leaves no temporary files behind after a write", async () => {
    const root = await makeRoot();
    const backend = createFileV2ImportLockChainBackend({ rootDirectory: root });

    await backend.write("flow-a", "payload");

    const entries = await readdir(root);
    expect(entries.filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("creates the root directory (and its parents) on demand", async () => {
    const root = join(await makeRoot(), "nested", "chains");
    const backend = createFileV2ImportLockChainBackend({ rootDirectory: root });

    await backend.write("flow-a", "payload");

    await expect(stat(root)).resolves.toBeDefined();
  });

  it("stores records private to the owner", async () => {
    const root = await makeRoot();
    const backend = createFileV2ImportLockChainBackend({ rootDirectory: root });

    await backend.write("flow-a", "payload");

    const [name] = await readdir(root);
    const mode = (await stat(join(root, name as string))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects a relative root directory rather than resolving it silently", () => {
    expect(() =>
      createFileV2ImportLockChainBackend({ rootDirectory: "relative/path" })
    ).toThrow(/absolute/i);
  });

  // The point of the whole exercise: lineage has to survive a process restart.
  // A fresh store over the same directory must see the earlier revisions.
  it("carries lineage across store instances over the same directory", async () => {
    const rootDirectory = await makeRoot();

    const first = new DurableV2ImportLockChainStore(
      createFileV2ImportLockChainBackend({ rootDirectory })
    );
    const root = entry("a");
    await first.append("flow-a", root);
    await first.append("flow-a", entry("b", root));

    const second = new DurableV2ImportLockChainStore(
      createFileV2ImportLockChainBackend({ rootDirectory })
    );

    const head = await second.head("flow-a");
    expect(head?.revision).toBe(1);
  });

  it("surfaces tampering to the store instead of hiding it", async () => {
    const rootDirectory = await makeRoot();
    const backend = createFileV2ImportLockChainBackend({ rootDirectory });
    const store = new DurableV2ImportLockChainStore(backend);
    await store.append("flow-a", entry("a"));

    const [name] = await readdir(rootDirectory);
    const recordPath = join(rootDirectory, name as string);
    const document = JSON.parse(await readFile(recordPath, "utf8"));
    document.entries[0].revision = 99;
    await writeFile(recordPath, JSON.stringify(document), "utf8");

    await expect(store.head("flow-a")).rejects.toThrow();
  });
});
