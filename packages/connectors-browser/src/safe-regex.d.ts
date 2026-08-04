/**
 * Ambient declaration for `safe-regex`.
 *
 * The package ships no types and has no `@types/safe-regex` counterpart
 * installed, so `import("safe-regex")` resolves to an implicit `any` and trips
 * TS7016 under `tsconfig.flipcheck.json` (which typechecks the `__tests__`
 * tree that `yarn build` excludes).
 *
 * It is declared here rather than added as a dependency because the only
 * consumer is `__tests__/interstitials-redos.test.ts`, where it asserts the
 * *structural* ReDoS guarantee for `CONTINUE_BUTTON_NAME`. The module is
 * currently reached as a hoisted transitive dependency.
 *
 * The real signature is `(re: RegExp | string, opts?) => boolean`; `limit`
 * caps the star-height repetition count safe-regex will tolerate.
 */
declare module "safe-regex" {
  function safeRegex(re: RegExp | string, opts?: { limit?: number }): boolean;
  export default safeRegex;
}
