import type { CanonicalJsonOptions } from '@datazup/canonical-json'

/**
 * Canonical JSON semantics shared by this package's digest sites
 * (capability manifests, observed-capability event identity, wired-runtime
 * definition hashes): object entries with `undefined` values are omitted,
 * `undefined`/function/symbol array items are elided, and keys are in
 * UTF-16 code-unit order. No @datazup/canonical-json preset carries this
 * exact combination yet; the vendored package must stay byte-identical to
 * shared-kit's (it is the cross-repo drift pin), so the options live here
 * until a preset is upstreamed to shared-kit first (ARCH27-T-13 follow-up).
 */
export const ADAPTER_CANONICAL_JSON_OPTIONS: CanonicalJsonOptions = {
  undefinedValues: {
    objectValue: 'omit',
    arrayItem: 'elide',
    topLevel: 'throw',
  },
  functionsAndSymbols: {
    objectValue: 'token',
    arrayItem: 'elide',
    topLevel: 'throw',
  },
  bigint: 'throw',
  cycles: { policy: 'throw', message: 'cannot canonicalize a cyclic adapter value' },
}
