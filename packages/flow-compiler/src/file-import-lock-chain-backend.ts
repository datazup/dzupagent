import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { V2ImportLockChainBackend } from "@dzupagent/flow-dsl";

export interface FileV2ImportLockChainBackendOptions {
  /** Absolute directory the chain documents live in. Created on demand. */
  readonly rootDirectory: string;
}

export interface FileV2ImportLockChainBackend extends V2ImportLockChainBackend {
  readonly rootDirectory: string;
}

/**
 * A filesystem {@link V2ImportLockChainBackend} for
 * {@link DurableV2ImportLockChainStore}.
 *
 * `@dzupagent/flow-dsl` deliberately contains no `node:fs` import — a package
 * that reads files cannot run everywhere the DSL is lowered — so it defines the
 * storage contract and leaves the storage itself to callers. This is the
 * reference implementation of that contract, and it lives here because
 * flow-compiler already depends on flow-dsl and already touches the filesystem.
 *
 * Storage only owes the store last-write-wins semantics per flow id. All
 * integrity rules stay in the store, which refuses bad data on the way in and
 * re-verifies it on the way out; this file therefore validates nothing about
 * the payload and treats it as opaque bytes.
 *
 * Two properties are worth stating explicitly, because both are load-bearing
 * and neither is visible from the interface:
 *
 *  - **Writes are atomic.** A chain document is the record of lineage, so a
 *    torn write is worse than no write: it destroys history that cannot be
 *    reconstructed. Each write lands in a private temporary file, is fsynced,
 *    and is then `rename`d over the target, which is atomic on POSIX. A reader
 *    concurrent with a writer sees either the old document or the new one.
 *
 *  - **The flow id never reaches the path.** Flow ids are author-supplied, and
 *    a value like `../../etc/cron.d/whatever` would otherwise escape the root
 *    directory. Records are named by the SHA-256 of the id, which is confined
 *    to the root by construction and is injective enough that ids differing
 *    only in path-illegal characters cannot collide.
 */
export function createFileV2ImportLockChainBackend(
  options: FileV2ImportLockChainBackendOptions
): FileV2ImportLockChainBackend {
  const { rootDirectory } = options;
  if (!isAbsolute(rootDirectory)) {
    throw new Error(
      `import-lock chain root directory must be absolute, received '${rootDirectory}'`
    );
  }

  const recordPathFor = (flowId: string): string =>
    join(
      rootDirectory,
      `${createHash("sha256").update(flowId).digest("hex")}.json`
    );

  return {
    rootDirectory,

    async read(flowId: string): Promise<string | undefined> {
      try {
        return await readFile(recordPathFor(flowId), "utf8");
      } catch (error) {
        // A flow with no chain yet is the ordinary first-run case, not a fault.
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    },

    async write(flowId: string, serialized: string): Promise<void> {
      await mkdir(rootDirectory, { recursive: true, mode: 0o700 });

      const recordPath = recordPathFor(flowId);
      const temporary = `${recordPath}.tmp-${process.pid}-${randomBytes(
        8
      ).toString("hex")}`;

      let handle;
      try {
        handle = await open(
          temporary,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600
        );
        await handle.writeFile(serialized, { encoding: "utf8" });
        // Durability before visibility: rename only publishes bytes the kernel
        // has already been told to persist.
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, recordPath);
      } catch (error) {
        if (handle !== undefined) await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
  };
}
