/**
 * ARCH27-T-08: the pipeline surface has exactly one authority,
 * `src/pipeline/index.ts`. The `./pipeline` subpath, the `./runtime` surface,
 * and the root barrel's pipeline section must all be verbatim re-exports of
 * it. Before this gate the three surfaces had measurably drifted (16/15
 * symbols reachable from only one entrypoint, checkpoint stores missing from
 * the root), so the reachable API depended on which entrypoint a consumer
 * happened to pick (ARCH27-N-11).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as authority from "../pipeline/index.js";
import * as pipelineSubpath from "../pipeline.js";
import * as root from "../index.js";
import * as runtime from "../runtime.js";

const valueKeys = (m: Record<string, unknown>) => Object.keys(m).sort();

describe("pipeline barrel parity (ARCH27-T-08)", () => {
  it("./pipeline exports exactly the authority set", () => {
    expect(valueKeys(pipelineSubpath as never)).toEqual(
      valueKeys(authority as never),
    );
  });

  it("./runtime exposes every authority export", () => {
    const runtimeKeys = new Set(Object.keys(runtime));
    const missing = valueKeys(authority as never).filter(
      (k) => !runtimeKeys.has(k),
    );
    expect(missing).toEqual([]);
  });

  it("the root barrel exposes every authority export", () => {
    const rootKeys = new Set(Object.keys(root));
    const missing = valueKeys(authority as never).filter(
      (k) => !rootKeys.has(k),
    );
    expect(missing).toEqual([]);
  });

  it("pipeline.ts stays a verbatim re-export of the authority (covers type-only exports)", () => {
    const src = readFileSync(
      new URL("../pipeline.ts", import.meta.url),
      "utf-8",
    );
    const exportStatements = src.match(/^export\b.*$/gm) ?? [];
    expect(exportStatements).toEqual(["export * from './pipeline/index.js'"]);
  });

  it("the root barrel's pipeline section stays a verbatim re-export of the authority", () => {
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
    expect(src).toContain('export * from "./pipeline/index.js";');
    const deepPipelineExports =
      src.match(/^export\b.*from "\.\/pipeline\/(?!index\.js)/gm) ?? [];
    expect(deepPipelineExports).toEqual([]);
  });
});
