/**
 * Minimal ambient declaration for the `node:crypto` surface used by
 * `idempotency.ts`.
 *
 * `@dzupagent/runtime-contracts` keeps `types: []` (no `@types/node`) so it
 * stays environment-neutral for browser/edge consumers. Rather than pulling
 * the entire `@types/node` surface into the package, we declare only the
 * structural shape of `createHash(...).update(...).digest('hex')` that the
 * canonical idempotency hasher depends on. At runtime the import resolves to
 * the real Node module; environments without `node:crypto` must not call the
 * idempotency helpers.
 */
declare module "node:crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}
