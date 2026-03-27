import { describe, it, expect, beforeEach } from 'vitest'

import { WasiFilesystem } from '../sandbox/wasm/wasi-fs.js'
import {
  CapabilityGuard,
  CapabilityDeniedError,
} from '../sandbox/wasm/capability-guard.js'
import type { WasiCapability } from '../sandbox/wasm/capability-guard.js'
import { WasmSandbox } from '../sandbox/wasm/wasm-sandbox.js'
import { WasmTypeScriptTranspiler } from '../sandbox/wasm/ts-transpiler.js'

// ===========================================================================
// WasiFilesystem
// ===========================================================================

describe('WasiFilesystem', () => {
  let fs: WasiFilesystem

  beforeEach(() => {
    fs = new WasiFilesystem()
  })

  it('writeFile/readFile round-trip', () => {
    const data = new TextEncoder().encode('hello world')
    fs.writeFile('/test.txt', data)
    const read = fs.readFile('/test.txt')
    expect(new TextDecoder().decode(read)).toBe('hello world')
  })

  it('readFile returns a copy, not a reference', () => {
    const data = new TextEncoder().encode('abc')
    fs.writeFile('/copy.txt', data)
    const read1 = fs.readFile('/copy.txt')
    read1[0] = 0
    const read2 = fs.readFile('/copy.txt')
    expect(read2[0]).toBe(97) // 'a'
  })

  it('stat returns correct info for files', () => {
    const data = new TextEncoder().encode('12345')
    fs.writeFile('/sized.txt', data)
    const s = fs.stat('/sized.txt')
    expect(s.type).toBe('file')
    expect(s.size).toBe(5)
    expect(s.createdAt).toBeGreaterThan(0)
    expect(s.modifiedAt).toBeGreaterThanOrEqual(s.createdAt)
  })

  it('stat returns correct info for directories', () => {
    fs.mkdir('/mydir')
    const s = fs.stat('/mydir')
    expect(s.type).toBe('directory')
  })

  it('stat throws for nonexistent path', () => {
    expect(() => fs.stat('/nope')).toThrow('ENOENT')
  })

  it('readdir lists directory contents', () => {
    fs.mkdir('/parent')
    fs.writeFile('/parent/a.txt', new Uint8Array(0))
    fs.writeFile('/parent/b.txt', new Uint8Array(0))
    const entries = fs.readdir('/parent')
    expect(entries.sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('readdir on root lists top-level entries', () => {
    fs.mkdir('/dir1')
    fs.writeFile('/file1.txt', new Uint8Array(0))
    const entries = fs.readdir('/')
    expect(entries.sort()).toEqual(['dir1', 'file1.txt'])
  })

  it('readdir throws on file', () => {
    fs.writeFile('/file.txt', new Uint8Array(0))
    expect(() => fs.readdir('/file.txt')).toThrow('ENOTDIR')
  })

  it('mkdir creates a directory', () => {
    fs.mkdir('/newdir')
    expect(fs.exists('/newdir')).toBe(true)
    expect(fs.stat('/newdir').type).toBe('directory')
  })

  it('mkdir throws if path already exists', () => {
    fs.mkdir('/dup')
    expect(() => fs.mkdir('/dup')).toThrow('EEXIST')
  })

  it('mkdirp creates nested directories', () => {
    fs.mkdirp('/a/b/c')
    expect(fs.exists('/a')).toBe(true)
    expect(fs.exists('/a/b')).toBe(true)
    expect(fs.exists('/a/b/c')).toBe(true)
  })

  it('unlink removes a file', () => {
    fs.writeFile('/rm.txt', new Uint8Array(0))
    expect(fs.exists('/rm.txt')).toBe(true)
    fs.unlink('/rm.txt')
    expect(fs.exists('/rm.txt')).toBe(false)
  })

  it('unlink removes a directory', () => {
    fs.mkdir('/rmdir')
    fs.unlink('/rmdir')
    expect(fs.exists('/rmdir')).toBe(false)
  })

  it('unlink throws for nonexistent path', () => {
    expect(() => fs.unlink('/ghost')).toThrow('ENOENT')
  })

  it('exists returns false for nonexistent paths', () => {
    expect(fs.exists('/nope')).toBe(false)
  })

  it('exists returns true for root', () => {
    expect(fs.exists('/')).toBe(true)
  })

  it('writeFile to nested path after mkdirp', () => {
    fs.mkdirp('/deep/nested')
    fs.writeFile('/deep/nested/file.txt', new TextEncoder().encode('ok'))
    expect(new TextDecoder().decode(fs.readFile('/deep/nested/file.txt'))).toBe('ok')
  })

  it('writeFile throws when writing to directory path', () => {
    fs.mkdir('/adir')
    expect(() => fs.writeFile('/adir', new Uint8Array(0))).toThrow('EISDIR')
  })

  it('readFile throws for directory', () => {
    fs.mkdir('/notafile')
    expect(() => fs.readFile('/notafile')).toThrow('EISDIR')
  })

  it('toJSON/fromJSON round-trip preserves structure', () => {
    fs.mkdir('/src')
    fs.writeFile('/src/main.ts', new TextEncoder().encode('console.log("hi")'))
    fs.writeFile('/readme.txt', new TextEncoder().encode('readme'))

    const json = fs.toJSON()
    const restored = WasiFilesystem.fromJSON(json)

    expect(restored.exists('/src')).toBe(true)
    expect(restored.stat('/src').type).toBe('directory')
    expect(new TextDecoder().decode(restored.readFile('/src/main.ts'))).toBe('console.log("hi")')
    expect(new TextDecoder().decode(restored.readFile('/readme.txt'))).toBe('readme')
  })

  it('toJSON/fromJSON preserves empty directories', () => {
    fs.mkdir('/empty')
    const json = fs.toJSON()
    const restored = WasiFilesystem.fromJSON(json)
    expect(restored.exists('/empty')).toBe(true)
    expect(restored.readdir('/empty')).toEqual([])
  })
})

// ===========================================================================
// CapabilityGuard
// ===========================================================================

describe('CapabilityGuard', () => {
  it('check passes for granted capabilities', () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>(['fs-read', 'stdout']))
    expect(() => guard.check('fs-read')).not.toThrow()
    expect(() => guard.check('stdout')).not.toThrow()
  })

  it('check throws CapabilityDeniedError for denied capabilities', () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>(['fs-read']))
    expect(() => guard.check('fs-write')).toThrow(CapabilityDeniedError)
    try {
      guard.check('fs-write')
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityDeniedError)
      expect((err as CapabilityDeniedError).capability).toBe('fs-write')
      expect((err as CapabilityDeniedError).message).toBe('Capability denied: fs-write')
    }
  })

  it('isGranted returns correct boolean', () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>(['env']))
    expect(guard.isGranted('env')).toBe(true)
    expect(guard.isGranted('clock')).toBe(false)
  })

  it('grant adds a new capability', () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>())
    expect(guard.isGranted('random')).toBe(false)
    guard.grant('random')
    expect(guard.isGranted('random')).toBe(true)
    expect(() => guard.check('random')).not.toThrow()
  })

  it('revoke removes a capability', () => {
    const guard = new CapabilityGuard(new Set<WasiCapability>(['stdin', 'stdout']))
    guard.revoke('stdin')
    expect(guard.isGranted('stdin')).toBe(false)
    expect(() => guard.check('stdin')).toThrow(CapabilityDeniedError)
    // stdout still granted
    expect(guard.isGranted('stdout')).toBe(true)
  })

  it('listGranted returns all granted capabilities', () => {
    const caps: WasiCapability[] = ['fs-read', 'fs-write', 'clock']
    const guard = new CapabilityGuard(new Set(caps))
    expect(guard.listGranted().sort()).toEqual(['clock', 'fs-read', 'fs-write'])
  })

  it('constructor does not share reference with input set', () => {
    const inputSet = new Set<WasiCapability>(['env'])
    const guard = new CapabilityGuard(inputSet)
    inputSet.add('clock')
    expect(guard.isGranted('clock')).toBe(false)
  })
})

// ===========================================================================
// WasmSandbox
// ===========================================================================

describe('WasmSandbox', () => {
  it('isAvailable returns a boolean', async () => {
    const sandbox = new WasmSandbox()
    const available = await sandbox.isAvailable()
    expect(typeof available).toBe('boolean')
  })

  it('isAvailable returns false when quickjs-emscripten is not installed', async () => {
    const sandbox = new WasmSandbox()
    // In the test env, quickjs-emscripten is not installed
    const available = await sandbox.isAvailable()
    expect(available).toBe(false)
  })

  it('execute throws when QuickJS is not available', async () => {
    const sandbox = new WasmSandbox()
    await expect(sandbox.execute('1 + 1')).rejects.toThrow(
      'QuickJS WASM not available',
    )
  })

  it('uploadFiles writes to WASI filesystem', async () => {
    const sandbox = new WasmSandbox()
    await sandbox.uploadFiles({
      '/src/index.ts': 'console.log("hello")',
      '/src/utils.ts': 'export const x = 1',
    })

    const fs = sandbox.getFilesystem()
    expect(fs.exists('/src/index.ts')).toBe(true)
    expect(fs.exists('/src/utils.ts')).toBe(true)
  })

  it('downloadFiles reads from WASI filesystem', async () => {
    const sandbox = new WasmSandbox()
    await sandbox.uploadFiles({
      '/a.txt': 'content-a',
      '/b.txt': 'content-b',
    })

    const downloaded = await sandbox.downloadFiles(['/a.txt', '/b.txt', '/missing.txt'])
    expect(downloaded['/a.txt']).toBe('content-a')
    expect(downloaded['/b.txt']).toBe('content-b')
    expect(downloaded['/missing.txt']).toBeUndefined()
  })

  it('uploadFiles/downloadFiles round-trip', async () => {
    const sandbox = new WasmSandbox()
    const files = {
      '/src/main.ts': 'const x: number = 42;',
      '/package.json': '{"name": "test"}',
    }
    await sandbox.uploadFiles(files)
    const result = await sandbox.downloadFiles(Object.keys(files))
    expect(result).toEqual(files)
  })

  it('cleanup resets filesystem', async () => {
    const sandbox = new WasmSandbox()
    await sandbox.uploadFiles({ '/file.txt': 'data' })
    expect(sandbox.getFilesystem().exists('/file.txt')).toBe(true)

    await sandbox.cleanup()
    expect(sandbox.getFilesystem().exists('/file.txt')).toBe(false)
  })

  it('initialFiles are pre-populated', () => {
    const sandbox = new WasmSandbox({
      initialFiles: {
        '/config.json': '{"key": "value"}',
        '/src/app.ts': 'console.log("app")',
      },
    })
    const fs = sandbox.getFilesystem()
    expect(fs.exists('/config.json')).toBe(true)
    expect(fs.exists('/src/app.ts')).toBe(true)
  })

  it('getCapabilities returns the guard', () => {
    const sandbox = new WasmSandbox({ capabilities: ['fs-read'] })
    const guard = sandbox.getCapabilities()
    expect(guard.isGranted('fs-read')).toBe(true)
    expect(guard.isGranted('fs-write')).toBe(false)
  })

  it('uploadFiles respects capability guard', async () => {
    const sandbox = new WasmSandbox({ capabilities: ['fs-read'] })
    await expect(
      sandbox.uploadFiles({ '/x.txt': 'data' }),
    ).rejects.toThrow('Capability denied: fs-write')
  })

  it('downloadFiles respects capability guard', async () => {
    const sandbox = new WasmSandbox({ capabilities: ['fs-write'] })
    // Upload works (fs-write granted)
    await sandbox.uploadFiles({ '/x.txt': 'data' })
    // Download fails (fs-read not granted)
    await expect(
      sandbox.downloadFiles(['/x.txt']),
    ).rejects.toThrow('Capability denied: fs-read')
  })

  it('getConfig returns resource limits', () => {
    const sandbox = new WasmSandbox({
      memoryLimitPages: 512,
      fuelLimit: 2_000_000,
      timeoutMs: 60_000,
    })
    const config = sandbox.getConfig()
    expect(config.memoryLimitPages).toBe(512)
    expect(config.fuelLimit).toBe(2_000_000)
    expect(config.timeoutMs).toBe(60_000)
  })

  it('default config values', () => {
    const sandbox = new WasmSandbox()
    const config = sandbox.getConfig()
    expect(config.memoryLimitPages).toBe(256)
    expect(config.fuelLimit).toBe(1_000_000)
    expect(config.timeoutMs).toBe(30_000)
  })
})

// ===========================================================================
// WasmTypeScriptTranspiler
// ===========================================================================

describe('WasmTypeScriptTranspiler', () => {
  let transpiler: WasmTypeScriptTranspiler

  beforeEach(() => {
    transpiler = new WasmTypeScriptTranspiler()
  })

  it('isAvailable returns a boolean', async () => {
    const available = await transpiler.isAvailable()
    expect(typeof available).toBe('boolean')
  })

  it('isAvailable returns false when esbuild-wasm is not installed', async () => {
    const available = await transpiler.isAvailable()
    expect(available).toBe(false)
  })

  it('transpile falls back to stripTypes when esbuild-wasm is unavailable', async () => {
    const result = await transpiler.transpile('const x: number = 42;')
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.diagnostics[0]).toContain('esbuild-wasm not available')
    expect(result.code).toBeDefined()
  })

  describe('stripTypes', () => {
    it('removes interface declarations', () => {
      const input = `interface Foo {
  bar: string;
  baz: number;
}
const x = 1;`
      const result = transpiler.stripTypes(input)
      expect(result).not.toContain('interface Foo')
      expect(result).toContain('const x = 1;')
    })

    it('removes type alias declarations', () => {
      const input = `type ID = string | number;
const y = "hello";`
      const result = transpiler.stripTypes(input)
      expect(result).not.toContain('type ID')
      expect(result).toContain('const y = "hello";')
    })

    it('removes parameter type annotations', () => {
      const input = 'function add(a: number, b: number) { return a + b; }'
      const result = transpiler.stripTypes(input)
      expect(result).toContain('function add(a, b)')
      expect(result).not.toContain(': number')
    })

    it('removes as casts', () => {
      const input = 'const el = document.getElementById("x") as HTMLDivElement;'
      const result = transpiler.stripTypes(input)
      expect(result).not.toContain('as HTMLDivElement')
    })

    it('removes access modifiers', () => {
      const input = `class Foo {
  public name = "test";
  private count = 0;
  protected data = [];
  readonly id = 1;
}`
      const result = transpiler.stripTypes(input)
      expect(result).not.toContain('public ')
      expect(result).not.toContain('private ')
      expect(result).not.toContain('protected ')
      expect(result).not.toContain('readonly ')
    })

    it('removes import type statements', () => {
      const input = `import type { Foo } from './foo';
import { bar } from './bar';`
      const result = transpiler.stripTypes(input)
      expect(result).not.toContain("import type { Foo } from './foo'")
      expect(result).toContain("import { bar } from './bar'")
    })

    it('removes type keyword from mixed imports', () => {
      const input = "import { type Foo, bar } from './mod';"
      const result = transpiler.stripTypes(input)
      expect(result).toContain("import { Foo, bar } from './mod';")
      expect(result).not.toContain('type Foo')
    })

    it('removes generic type parameters from functions', () => {
      const input = 'function identity<T extends object>(x) { return x; }'
      const result = transpiler.stripTypes(input)
      expect(result).toContain('function identity(x)')
      expect(result).not.toContain('<T extends object>')
    })

    it('removes declare statements', () => {
      const input = `declare const __DEV__: boolean;
const x = 1;`
      const result = transpiler.stripTypes(input)
      expect(result).not.toContain('declare')
      expect(result).toContain('const x = 1;')
    })

    it('removes non-null assertions', () => {
      const input = 'const val = obj!.prop;'
      const result = transpiler.stripTypes(input)
      expect(result).toContain('const val = obj.prop;')
    })

    it('preserves regular JavaScript code', () => {
      const input = `const x = 42;
function greet(name) {
  return "Hello, " + name;
}
const arr = [1, 2, 3];`
      const result = transpiler.stripTypes(input)
      expect(result).toContain('const x = 42;')
      expect(result).toContain('function greet(name)')
      expect(result).toContain('const arr = [1, 2, 3];')
    })

    it('removes enum declarations', () => {
      const input = `enum Color {
  Red,
  Green,
  Blue,
}
const x = 1;`
      const result = transpiler.stripTypes(input)
      expect(result).not.toContain('enum Color')
      expect(result).toContain('const x = 1;')
    })
  })
})
