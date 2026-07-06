import type { FlowFragmentV1, FlowNode } from "@dzupagent/flow-ast";

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
          type: "set",
          id: "set_closeout_status",
          assign: { closeoutStatus: "{{ params.status }}" },
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
      itemsKey: { type: "string", required: true },
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
          source: "{{ params.itemsKey }}",
          as: "validationItem",
          collect: {
            from: "validationStatus",
            into: "validationStatuses",
          },
          body: [
            {
              "validate.schema": {
                id: "classify_validation",
                source: "{{ state.validationItem.result }}",
                schema: "dzup.sdlc.validation-result@1",
                output: "validationStatus",
              },
            } as unknown as FlowNode,
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
