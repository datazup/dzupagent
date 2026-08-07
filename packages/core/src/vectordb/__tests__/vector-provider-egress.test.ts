/**
 * Vector-backend egress classification (SHARED-KIT-SEC-M-36 support).
 *
 * The embedding channel is not the only way `auto`-style wiring can send
 * memory content off-process: `QDRANT_URL` / `PINECONE_API_KEY` /
 * `TURBOPUFFER_API_KEY` / `LANCEDB_URI` (or a bare `VECTOR_PROVIDER`) each
 * redirect the *documents and their metadata* to a backend outside this
 * process. A gate that inspects only the embedder would miss all of them, so
 * the classification lives next to the detection it classifies.
 */
import { describe, it, expect } from "vitest";
import {
  detectVectorProvider,
  isExternalVectorProvider,
  IN_PROCESS_VECTOR_PROVIDERS,
} from "../auto-detect.js";

describe("isExternalVectorProvider", () => {
  it("treats the in-memory backend as in-process", () => {
    expect(isExternalVectorProvider("memory")).toBe(false);
    expect(IN_PROCESS_VECTOR_PROVIDERS).toContain("memory");
  });

  it.each(["qdrant", "pinecone", "turbopuffer", "lancedb", "chroma"])(
    "treats %s as external",
    (provider) => {
      expect(isExternalVectorProvider(provider)).toBe(true);
    },
  );

  it("treats an unrecognised provider name as external", () => {
    // Fail towards "this needs an acknowledgement": an unknown VECTOR_PROVIDER
    // value is exactly the case where we cannot prove the data stays local.
    expect(isExternalVectorProvider("some-new-vendor")).toBe(true);
  });
});

describe("detectVectorProvider egress, per env", () => {
  it("classifies an empty env as in-process", () => {
    const detected = detectVectorProvider({});
    expect(detected.provider).toBe("memory");
    expect(isExternalVectorProvider(detected.provider)).toBe(false);
  });

  it.each([
    ["QDRANT_URL", "http://localhost:6333", "qdrant"],
    ["PINECONE_API_KEY", "pk-test", "pinecone"],
    ["TURBOPUFFER_API_KEY", "tp-test", "turbopuffer"],
    ["LANCEDB_URI", "./data/lance", "lancedb"],
    ["VECTOR_PROVIDER", "chroma", "chroma"],
  ])("%s alone selects an external backend", (envVar, value, provider) => {
    const detected = detectVectorProvider({ [envVar]: value });
    expect(detected.provider).toBe(provider);
    expect(isExternalVectorProvider(detected.provider)).toBe(true);
  });
});
