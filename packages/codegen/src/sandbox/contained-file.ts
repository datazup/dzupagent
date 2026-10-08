import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";

/** Open from pinned directory descriptors, refusing every symlink component. */
export async function withContainedFile<T>(root: string, target: string, create: boolean, flags: number, action: (file: FileHandle) => Promise<T>): Promise<T> {
  const base = resolve(root);
  const rel = relative(base, resolve(target));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error("Path traversal detected");
  if (process.platform !== "linux") throw new Error("Secure descriptor-relative file access requires Linux");
  const handles: FileHandle[] = [];
  try {
    let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    // Pin the configured root's ancestors too: a symlink above the root is
    // just as capable of redirecting a write as one below it.
    const parts = [...base.split("/").filter(Boolean), ...rel.split("/")];
    const leaf = parts.pop()!;
    for (const part of parts) {
      const anchored = `/proc/self/fd/${parent.fd}/${part}`;
      if (create) {
        try { await mkdir(anchored); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      parent = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(parent);
    }
    const file = await open(`/proc/self/fd/${parent.fd}/${leaf}`, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(file);
    if (!(await file.stat()).isFile()) throw new Error("Path traversal detected: target is not a regular file");
    return await action(file);
  } catch (error) {
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new Error("Path traversal detected: symlink component", { cause: error });
    throw error;
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}
