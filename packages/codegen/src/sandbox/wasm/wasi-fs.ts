/**
 * In-memory WASI-compatible filesystem.
 *
 * Provides a tree-structured virtual filesystem that can be mounted
 * into a WASM sandbox. Fully functional without any WASM runtime —
 * used by WasmSandbox for file I/O and independently for testing.
 */

export interface WasiFileEntry {
  type: 'file' | 'directory'
  content?: Uint8Array
  children?: Map<string, WasiFileEntry>
  permissions?: number
  createdAt: number
  modifiedAt: number
}

export interface WasiStatResult {
  type: 'file' | 'directory'
  size: number
  createdAt: number
  modifiedAt: number
}

/** Normalize a path: strip trailing slashes, collapse double slashes, ensure leading slash. */
function normalizePath(raw: string): string {
  let p = raw.replace(/\/+/g, '/').replace(/\/+$/, '')
  if (!p.startsWith('/')) p = '/' + p
  return p
}

/** Split a normalized path into segments (empty first segment from leading / is dropped). */
function segments(path: string): string[] {
  return normalizePath(path)
    .split('/')
    .filter((s) => s.length > 0)
}

export class WasiFilesystem {
  private root: WasiFileEntry

  constructor() {
    this.root = {
      type: 'directory',
      children: new Map(),
      permissions: 0o755,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Resolve a path to the parent directory and the final segment name. */
  private resolve(path: string): { parent: WasiFileEntry; name: string } {
    const parts = segments(path)
    if (parts.length === 0) {
      throw new Error(`Invalid path: ${path}`)
    }
    const name = parts[parts.length - 1]!
    let current = this.root

    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!
      const child = current.children?.get(seg)
      if (!child || child.type !== 'directory') {
        throw new Error(`ENOENT: no such directory '${parts.slice(0, i + 1).join('/')}'`)
      }
      current = child
    }

    return { parent: current, name }
  }

  /** Get the entry at the given path (root returns the root). */
  private entry(path: string): WasiFileEntry | undefined {
    const parts = segments(path)
    if (parts.length === 0) return this.root

    let current = this.root
    for (const seg of parts) {
      const child = current.children?.get(seg)
      if (!child) return undefined
      current = child
    }
    return current
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  readFile(path: string): Uint8Array {
    const e = this.entry(path)
    if (!e) throw new Error(`ENOENT: no such file '${path}'`)
    if (e.type !== 'file') throw new Error(`EISDIR: is a directory '${path}'`)
    return new Uint8Array(e.content ?? new Uint8Array(0))
  }

  writeFile(path: string, content: Uint8Array): void {
    const { parent, name } = this.resolve(path)
    const existing = parent.children?.get(name)
    const now = Date.now()

    if (existing && existing.type === 'directory') {
      throw new Error(`EISDIR: is a directory '${path}'`)
    }

    const entry: WasiFileEntry = {
      type: 'file',
      content: new Uint8Array(content),
      permissions: existing?.permissions ?? 0o644,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
    }

    if (!parent.children) {
      parent.children = new Map()
    }
    parent.children.set(name, entry)
    parent.modifiedAt = now
  }

  stat(path: string): WasiStatResult {
    const e = this.entry(path)
    if (!e) throw new Error(`ENOENT: no such file or directory '${path}'`)

    return {
      type: e.type,
      size:
        e.type === 'file'
          ? (e.content?.byteLength ?? 0)
          : (e.children?.size ?? 0),
      createdAt: e.createdAt,
      modifiedAt: e.modifiedAt,
    }
  }

  readdir(path: string): string[] {
    const e = this.entry(path)
    if (!e) throw new Error(`ENOENT: no such directory '${path}'`)
    if (e.type !== 'file' && !e.children) return []
    if (e.type === 'file') throw new Error(`ENOTDIR: not a directory '${path}'`)
    return [...(e.children?.keys() ?? [])]
  }

  mkdir(path: string): void {
    const { parent, name } = this.resolve(path)
    if (parent.children?.has(name)) {
      throw new Error(`EEXIST: '${path}' already exists`)
    }
    if (!parent.children) {
      parent.children = new Map()
    }

    const now = Date.now()
    parent.children.set(name, {
      type: 'directory',
      children: new Map(),
      permissions: 0o755,
      createdAt: now,
      modifiedAt: now,
    })
    parent.modifiedAt = now
  }

  /** Recursively create directories along the path (like mkdir -p). */
  mkdirp(path: string): void {
    const parts = segments(path)
    let current = this.root

    for (const seg of parts) {
      if (!current.children) {
        current.children = new Map()
      }
      let child = current.children.get(seg)
      if (!child) {
        const now = Date.now()
        child = {
          type: 'directory',
          children: new Map(),
          permissions: 0o755,
          createdAt: now,
          modifiedAt: now,
        }
        current.children.set(seg, child)
        current.modifiedAt = now
      } else if (child.type !== 'directory') {
        throw new Error(`ENOTDIR: '${seg}' is not a directory`)
      }
      current = child
    }
  }

  unlink(path: string): void {
    const { parent, name } = this.resolve(path)
    const child = parent.children?.get(name)
    if (!child) {
      throw new Error(`ENOENT: no such file or directory '${path}'`)
    }
    parent.children!.delete(name)
    parent.modifiedAt = Date.now()
  }

  exists(path: string): boolean {
    return this.entry(path) !== undefined
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJSON(): Record<string, unknown> {
    return serializeEntry(this.root)
  }

  static fromJSON(data: Record<string, unknown>): WasiFilesystem {
    const fs = new WasiFilesystem()
    fs.root = deserializeEntry(data)
    return fs
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeEntry(entry: WasiFileEntry): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: entry.type,
    permissions: entry.permissions,
    createdAt: entry.createdAt,
    modifiedAt: entry.modifiedAt,
  }

  if (entry.type === 'file' && entry.content) {
    // Store as base64
    result['content'] = uint8ToBase64(entry.content)
  }

  if (entry.children && entry.children.size > 0) {
    const children: Record<string, unknown> = {}
    for (const [name, child] of entry.children) {
      children[name] = serializeEntry(child)
    }
    result['children'] = children
  }

  return result
}

function deserializeEntry(data: Record<string, unknown>): WasiFileEntry {
  const entry: WasiFileEntry = {
    type: data['type'] as 'file' | 'directory',
    permissions: (data['permissions'] as number | undefined) ?? 0o644,
    createdAt: (data['createdAt'] as number | undefined) ?? Date.now(),
    modifiedAt: (data['modifiedAt'] as number | undefined) ?? Date.now(),
  }

  if (typeof data['content'] === 'string') {
    entry.content = base64ToUint8(data['content'])
  }

  if (data['children'] && typeof data['children'] === 'object') {
    entry.children = new Map()
    for (const [name, childData] of Object.entries(
      data['children'] as Record<string, unknown>,
    )) {
      entry.children.set(name, deserializeEntry(childData as Record<string, unknown>))
    }
  }

  return entry
}

/** Encode Uint8Array to base64 string (works in Node and browsers). */
function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  // Browser fallback
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

/** Decode base64 string to Uint8Array. */
function base64ToUint8(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'))
  }
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
