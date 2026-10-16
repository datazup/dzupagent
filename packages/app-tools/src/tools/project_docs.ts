import { constants, promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import type { DomainToolDefinition } from "../types.js";
import type {
  AnyExecutableDomainTool,
  ExecutableDomainTool,
} from "./shared.js";

/**
 * project_docs.* — read-oriented filesystem tools scoped to a root directory.
 *
 * Every path is resolved against `rootDir` and rejected if it escapes the
 * root. `project_docs.list` uses a minimal glob matcher (supports `*`, `**`,
 * `?`) to avoid a `fast-glob` dependency.
 */

/** Tiny glob-to-RegExp converter. Supports `*`, `**`, and `?`. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") {
          i++;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c !== undefined && /[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else if (c !== undefined) {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

async function walk(dir: string, rootDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      results.push(...(await walk(full, rootDir)));
    } else if (entry.isFile()) {
      results.push(path.relative(rootDir, full).split(path.sep).join("/"));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// project_docs.list
// ---------------------------------------------------------------------------

interface ListInput {
  pattern: string;
}

interface ListOutput {
  files: string[];
}

function buildProjectDocsList(
  rootDir: string,
): ExecutableDomainTool<ListInput, ListOutput> {
  const definition: DomainToolDefinition = {
    name: "project_docs.list",
    description: "List project documentation files matching a glob pattern.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. **/*.md" },
      },
    },
    outputSchema: {
      type: "object",
      required: ["files"],
      properties: {
        files: { type: "array", items: { type: "string" } },
      },
    },
    permissionLevel: "read",
    sideEffects: [],
    namespace: "project_docs",
  };

  return {
    definition,
    async execute(input: ListInput): Promise<ListOutput> {
      const re = globToRegExp(input.pattern);
      const all = await walk(rootDir, rootDir);
      const files = all.filter((f) => re.test(f)).sort();
      return { files };
    },
  };
}

// ---------------------------------------------------------------------------
// project_docs.read
// ---------------------------------------------------------------------------

interface ReadInput {
  path: string;
}

interface ReadOutput {
  content: string;
}

/** Read from pinned directory descriptors, refusing every symlink component. */
async function readContainedFile(rootDir: string, rel: string): Promise<string> {
  if (!rel) {
    throw new Error("project_docs.read refused to read outside rootDir");
  }
  const handles: FileHandle[] = [];
  const directoryFlags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    let parent = await fs.open("/", directoryFlags);
    handles.push(parent);
    const parts = [...rootDir.split("/").filter(Boolean), ...rel.split("/")];
    const leaf = parts.pop()!;
    for (const part of parts) {
      parent = await fs.open(`/proc/self/fd/${parent.fd}/${part}`, directoryFlags);
      handles.push(parent);
    }
    const file = await fs.open(
      `/proc/self/fd/${parent.fd}/${leaf}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    handles.push(file);
    if (!(await file.stat()).isFile()) {
      throw new Error("project_docs.read refused to read outside rootDir");
    }
    return await file.readFile("utf-8");
  } catch (error) {
    if (
      ["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      throw new Error("project_docs.read refused to read outside rootDir", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

function buildProjectDocsRead(
  rootDir: string,
): ExecutableDomainTool<ReadInput, ReadOutput> {
  const definition: DomainToolDefinition = {
    name: "project_docs.read",
    description: "Read the contents of a project documentation file.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Path relative to rootDir" },
      },
    },
    outputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string" },
      },
    },
    permissionLevel: "read",
    sideEffects: [],
    namespace: "project_docs",
  };

  return {
    definition,
    async execute(input: ReadInput): Promise<ReadOutput> {
      const rel = input.path;
      if (path.isAbsolute(rel)) {
        throw new Error(
          "project_docs.read requires a path relative to rootDir",
        );
      }
      const resolved = path.resolve(rootDir, rel);
      const relCheck = path.relative(rootDir, resolved);
      if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
        throw new Error("project_docs.read refused to read outside rootDir");
      }
      if (process.platform !== "linux") {
        throw new Error("project_docs.read refused to read outside rootDir");
      }
      const canonicalRoot = await fs.realpath(rootDir);
      const content = await readContainedFile(canonicalRoot, relCheck);
      return { content };
    },
  };
}

export function buildProjectDocsTools(
  rootDir: string,
): AnyExecutableDomainTool[] {
  return [buildProjectDocsList(rootDir), buildProjectDocsRead(rootDir)];
}
