import {
  flowReference,
  type FlowFragmentV1,
} from "@dzupagent/flow-ast";

import { createFragmentRegistry } from "./registry.js";

export const BUILT_IN_SDL_FRAGMENT_DEFINITIONS: readonly FlowFragmentV1[] = [
  {
    dsl: "dzupflow/v1",
    documentType: "fragment",
    id: "sdlc.closeout",
    version: 1,
    description: "Emit final SDLC closeout status for a completed packet.",
    params: {
      status: { type: "string", default: "complete" },
    },
    exports: {
      status: "{{ state.closeoutStatus }}",
    },
    root: {
      type: "sequence",
      nodes: [
        {
          type: "validate.schema",
          id: "classify_closeout_status",
          source: "{{ params.status }}",
          schema: "dzup.sdlc.closeout-status@1",
          output: "closeoutStatus",
        },
      ],
    },
  },
  {
    dsl: "dzupflow/v1",
    documentType: "fragment",
    id: "sdlc.batch_validation",
    version: 1,
    description: "Validate an ordered batch of SDLC result items and collect their statuses.",
    params: {
      items: { type: "string", required: true },
      concurrency: { type: "number", default: 1 },
      failFast: { type: "boolean", default: false },
    },
    exports: {
      statuses: "{{ state.validationStatuses }}",
    },
    root: {
      type: "sequence",
      nodes: [
        {
          type: "for_each",
          id: "validate_each",
          source: "{{ params.items }}",
          as: "validationItem",
          concurrency: flowReference<number>("params.concurrency"),
          failFast: flowReference<boolean>("params.failFast"),
          collect: {
            from: "validationStatus",
            into: "validationStatuses",
          },
          body: [
            {
              type: "validate.schema",
              id: "classify_validation",
              source: "{{ state.validationItem.result }}",
              schema: "dzup.sdlc.validation-result@1",
              output: "validationStatus",
            },
          ],
        },
      ],
    },
  },
  {
    dsl: "dzupflow/v1",
    documentType: "fragment",
    id: "sdlc.current_truth",
    version: 1,
    description: "Capture a current repository truth snapshot through a runtime leaf.",
    params: {
      scope: { type: "string", default: "." },
    },
    exports: {
      truth: "{{ state.currentTruth }}",
    },
    root: {
      type: "sequence",
      nodes: [
        {
          type: "action",
          id: "read_current_truth",
          toolRef: "sdlc.current_truth",
          input: { scope: "{{ params.scope }}" },
        },
        {
          type: "set",
          id: "store_current_truth",
          assign: { currentTruth: "{{ state.read_current_truth }}" },
        },
      ],
    },
  },
  {
    dsl: "dzupflow/v1",
    documentType: "fragment",
    id: "sdlc.gated_packet",
    version: 1,
    description: "Dispatch an implementation packet and store its gate status.",
    params: {
      packetRef: { type: "string", required: true },
    },
    exports: {
      status: "{{ state.packetStatus }}",
    },
    root: {
      type: "sequence",
      nodes: [
        {
          type: "worker.dispatch",
          id: "dispatch_packet",
          dispatchId: "sdlc.implement_packet",
          provider: "codex",
          instructions: "Implement SDLC packet {{ params.packetRef }} and report gate status.",
          input: { packetRef: "{{ params.packetRef }}" },
          outputKey: "packetStatus",
        },
      ],
    },
  },
  {
    dsl: "dzupflow/v1",
    documentType: "fragment",
    id: "sdlc.git_truth",
    version: 1,
    description: "Capture git status as a truth input for SDLC orchestration.",
    params: {
      cwd: { type: "string", default: "." },
    },
    exports: {
      status: "{{ state.gitStatus }}",
    },
    root: {
      type: "sequence",
      nodes: [
        {
          type: "shell.run",
          id: "read_git_status",
          command: "git status --short --branch",
          cwd: "{{ params.cwd }}",
          output: "gitStatus",
        },
      ],
    },
  },
  {
    dsl: "dzupflow/v1",
    documentType: "fragment",
    id: "sdlc.packet_fanout",
    version: 1,
    description: "Dispatch an ordered batch of SDLC packets and collect their gate statuses.",
    params: {
      packets: { type: "string", required: true },
      concurrency: { type: "number", default: 1 },
      failFast: { type: "boolean", default: false },
    },
    exports: {
      statuses: "{{ state.packetStatuses }}",
    },
    root: {
      type: "sequence",
      nodes: [
        {
          type: "for_each",
          id: "dispatch_each_packet",
          source: "{{ params.packets }}",
          as: "packetItem",
          concurrency: flowReference<number>("params.concurrency"),
          failFast: flowReference<boolean>("params.failFast"),
          collect: {
            from: "each_packet__packetStatus",
            into: "packetStatuses",
          },
          body: [
            {
              type: "sdlc.gated_packet",
              id: "each_packet",
              packetRef: "{{ state.packetItem.ref }}",
            },
          ],
        },
      ],
    },
  },
  {
    dsl: "dzupflow/v1",
    documentType: "fragment",
    id: "sdlc.validation_gate",
    version: 1,
    description: "Run a validation command and classify the result.",
    params: {
      cwd: { type: "string", required: true },
      command: { type: "string", default: "yarn test" },
    },
    exports: {
      status: "{{ state.validationStatus }}",
    },
    root: {
      type: "sequence",
      nodes: [
        {
          type: "shell.run",
          id: "run_validation",
          command: "{{ params.command }}",
          cwd: "{{ params.cwd }}",
          output: "validationOutput",
        },
        {
          type: "validate.schema",
          id: "classify_validation",
          source: "validationOutput",
          schema: "dzup.sdlc.validation-result@1",
          output: "validationStatus",
        },
      ],
    },
  },
];

export const BUILT_IN_FRAGMENT_REGISTRY = createFragmentRegistry(
  BUILT_IN_SDL_FRAGMENT_DEFINITIONS,
);
