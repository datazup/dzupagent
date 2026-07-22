import { FLOW_NODE_KINDS } from "@dzupagent/flow-ast";

export const FLOW_PROFILE_MANIFEST_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "dzupagent.flowProfileManifest/v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "ref",
    "namespace",
    "name",
    "version",
    "kind",
    "owner",
    "lowering",
    "portable",
    "nodeKinds",
    "capabilities",
    "dependencies",
  ],
  properties: {
    schema: { const: "dzupagent.flowProfileManifest/v1" },
    ref: {
      type: "string",
      pattern: "^[a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*@[1-9][0-9]*$",
    },
    namespace: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    name: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    version: {
      type: "string",
      pattern:
        "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
    },
    kind: { enum: ["kernel", "extension"] },
    owner: { enum: ["dzupagent", "host", "codev"] },
    lowering: { enum: ["core-ir", "opaque-host-action"] },
    portable: { type: "boolean" },
    nodeKinds: {
      type: "array",
      uniqueItems: true,
      items: { enum: FLOW_NODE_KINDS },
    },
    capabilities: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    dependencies: {
      type: "array",
      uniqueItems: true,
      items: { type: "string" },
    },
  },
} as const;

export const FLOW_PROFILE_LOCK_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "dzupagent.flowProfileLock/v1",
  type: "object",
  additionalProperties: false,
  required: ["schema", "profiles"],
  properties: {
    schema: { const: "dzupagent.flowProfileLock/v1" },
    profiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "version", "manifestHash"],
        properties: {
          ref: {
            type: "string",
            pattern: "^[a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*@[1-9][0-9]*$",
          },
          version: { type: "string" },
          manifestHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        },
      },
    },
  },
} as const;
