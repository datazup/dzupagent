/**
 * Minimal ambient shapes for the LanceDB adapter's optional peer
 * dependencies.
 *
 * The adapter loads these with literal dynamic `import()` specifiers so that
 * dependency scanners and boundary gates can see the edges (ARCH27-N-07 —
 * `const moduleName = '…'; import(moduleName)` hid them from madge). The
 * packages are optional peers that are usually NOT installed in this
 * workspace, so without these declarations the literal specifiers would fail
 * compilation. Only the members the adapter actually touches are declared;
 * richer typing happens at the adapter seams (`LanceDBConnection`,
 * `ArrowLib`).
 *
 * These declarations deliberately shadow the real packages' types when the
 * peers ARE installed: compilation must not depend on hoisting luck, and the
 * adapter code treats both modules through its own seam types anyway.
 */
declare module "@lancedb/lancedb" {
  export function connect(uri: string): Promise<unknown>;
}

declare module "apache-arrow" {
  const arrowModule: unknown;
  export default arrowModule;
}
