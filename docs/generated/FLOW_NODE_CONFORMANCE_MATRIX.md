# Flow Node And Target Conformance Matrix

> Generated from the public `FLOW_NODE_KIND_REGISTRY` and the compiler capability manifests. Do not edit by hand.

Schema: `dzupagent.flowConformanceMatrix/v1`

## Nodes

| Node | Parse | Validate | Status | Lowering | Current route | Recommended profile | Owner | Runtime requirements | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sequence` | yes | yes | supported | native | `skill-chain` | `dzup.core@1` | dzupagent | none |  |
| `action` | yes | yes | supported | native | `skill-chain` | `dzup.core@1` | dzupagent | none |  |
| `for_each` | yes | yes | supported | native | `pipeline` | `dzup.core@1` | dzupagent | none |  |
| `branch` | yes | yes | supported | native | `workflow-builder` | `dzup.core@1` | dzupagent | none |  |
| `approval` | yes | yes | supported | native | `workflow-builder` | `dzup.core@1` | dzupagent | none |  |
| `clarification` | yes | yes | supported | native | `workflow-builder` | `dzup.core@1` | dzupagent | none |  |
| `persona` | yes | yes | supported | native | `workflow-builder` | `dzup.llm@1` | dzupagent | none |  |
| `route` | yes | yes | supported | native | `workflow-builder` | `dzup.adapters@1` | dzupagent | none |  |
| `parallel` | yes | yes | supported | native | `workflow-builder` | `dzup.core@1` | dzupagent | none |  |
| `complete` | yes | yes | partial | degraded | `skill-chain` | `dzup.core@1` | dzupagent | `flow.runtime.complete@1` | Terminal semantics are native in pipeline artifacts but need an executable anchor in skill-chain flows. |
| `spawn` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.agent@1` | dzupagent | `flow.runtime.spawn@1` | Preserved as artifact metadata; execution remains host-owned. |
| `classify` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.llm@1` | dzupagent | `flow.runtime.classify@1` | Preserved as artifact metadata; execution remains host-owned. |
| `emit` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.core@1` | dzupagent | `flow.runtime.emit@1` | Event emission is not represented as an executable generic target node. |
| `memory` | yes | yes | partial | degraded | `skill-chain` | `dzup.rag@1` | dzupagent | `flow.runtime.memory@1` | Skill-chain has a memory projection; graph targets retain metadata only. |
| `set` | yes | yes | partial | runtime-leaf | `skill-chain` | `dzup.core@1` | dzupagent | `flow.runtime.set@1` | Current routing classifies set as sequential while graph lowering models it as a runtime leaf. |
| `checkpoint` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.core@1` | dzupagent | `flow.runtime.checkpoint@1` | Checkpoint policy is carried separately; the node is not a generic executable graph node. |
| `restore` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.core@1` | dzupagent | `flow.runtime.restore@1` | Restore policy is carried separately; the node is not a generic executable graph node. |
| `try_catch` | yes | yes | partial | degraded | `workflow-builder` | `dzup.core@1` | dzupagent | `flow.runtime.try_catch@1` | The try body lowers; catch-path execution remains runtime-owned. |
| `loop` | yes | yes | partial | degraded | `pipeline` | `dzup.core@1` | dzupagent | `flow.runtime.loop@1` | The loop body lowers but the authored condition is runtime-owned. |
| `http` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.core@1` | dzupagent | `flow.runtime.http@1` | HTTP execution requires a host handler and is not emitted as a generic target node. |
| `wait` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.core@1` | dzupagent | `flow.runtime.wait@1` | Durable timer/event wait semantics are not normalized in generic targets. |
| `subflow` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.core@1` | dzupagent | `flow.runtime.subflow@1` | Subflows must be inlined before lowering or executed by a host. |
| `prompt` | yes | yes | host-only | runtime-leaf | `planning-dag` | `dzup.llm@1` | host | `flow.runtime.prompt@1` |  |
| `return_to` | yes | yes | unsupported | unsupported | `pipeline` | `dzup.core@1` | dzupagent | `flow.runtime.return_to@1` | Accepted by the AST but rejected by every current generic compiler target. |
| `agent` | yes | yes | host-only | runtime-leaf | `planning-dag` | `dzup.agent@1` | host | `flow.runtime.agent@1` |  |
| `validate` | yes | yes | host-only | runtime-leaf | `planning-dag` | `dzup.sdlc@1` | host | `flow.runtime.validate@1` |  |
| `worker.dispatch` | yes | yes | host-only | runtime-leaf | `planning-dag` | `dzup.fleet@1` | host | `flow.runtime.worker.dispatch@1` |  |
| `fleet.dispatch` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.fleet@1` | dzupagent | `flow.runtime.fleet.dispatch@1` | Collected into fleetSteps side metadata for a host runtime. |
| `fleet.gather` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.fleet@1` | dzupagent | `flow.runtime.fleet.gather@1` | Collected into fleetSteps side metadata for a host runtime. |
| `fleet.contract-net` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.fleet@1` | dzupagent | `flow.runtime.fleet.contract-net@1` | Collected into fleetSteps side metadata for a host runtime. |
| `knowledge.write` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.rag@1` | dzupagent | `flow.runtime.knowledge.write@1` | Knowledge execution is host-owned and not emitted as a generic target node. |
| `knowledge.query` | yes | yes | partial | metadata-only | `skill-chain` | `dzup.rag@1` | dzupagent | `flow.runtime.knowledge.query@1` | Knowledge execution is host-owned and not emitted as a generic target node. |
| `shell.run` | yes | yes | host-only | runtime-leaf | `planning-dag` | `dzup.sdlc@1` | host | `flow.runtime.shell.run@1` |  |
| `evidence.write` | yes | yes | host-only | runtime-leaf | `planning-dag` | `dzup.sdlc@1` | host | `flow.runtime.evidence.write@1` |  |
| `validate.schema` | yes | yes | host-only | runtime-leaf | `planning-dag` | `dzup.sdlc@1` | host | `flow.runtime.validate.schema@1` |  |
| `adapter.run` | yes | yes | host-only | runtime-leaf | `planning-dag` | `dzup.adapters@1` | host | `flow.runtime.adapter.run@1` |  |
| `adapter.race` | yes | yes | host-only | runtime-leaf | `planning-dag` | `dzup.adapters@1` | host | `flow.runtime.adapter.race@1` |  |
| `adapter.parallel` | yes | yes | host-only | runtime-leaf | `planning-dag` | `dzup.adapters@1` | host | `flow.runtime.adapter.parallel@1` |  |
| `adapter.supervisor` | yes | yes | host-only | runtime-leaf | `planning-dag` | `dzup.adapters@1` | host | `flow.runtime.adapter.supervisor@1` |  |
| `spdd.import_sources` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.import_sources@1` |  |
| `spdd.build_source_pack` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.build_source_pack@1` |  |
| `spdd.run_analysis` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.run_analysis@1` |  |
| `spdd.generate_canvas` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.generate_canvas@1` |  |
| `spdd.validate_canvas` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.validate_canvas@1` |  |
| `spdd.review_canvas` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.review_canvas@1` |  |
| `spdd.project_plan` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.project_plan@1` |  |
| `spdd.arm_dispatch` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.arm_dispatch@1` |  |
| `spdd.run_validation` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.run_validation@1` |  |
| `spdd.collect_proof` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.collect_proof@1` |  |
| `spdd.scan_drift` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.scan_drift@1` |  |
| `spdd.create_sync_proposal` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.create_sync_proposal@1` |  |
| `spdd.agent_swarm` | yes | yes | host-only | runtime-leaf | `planning-dag` | `codev.spdd@1` | codev | `flow.runtime.spdd.agent_swarm@1` |  |

## Targets

| Target | Capability | Route features | Execution | Durability | Limitations |
| --- | --- | --- | --- | --- | --- |
| `skill-chain` | `flow.target.skill-chain@1` | sequential | inline | volatile | `ACTION_ANCHOR_REQUIRED`: At least one executable action step is required.<br>`NO_RUNTIME_LEAVES`: Runtime leaves route to planning-dag instead. |
| `workflow-builder` | `flow.target.workflow-builder@1` | branch, parallel, suspend | inline | volatile, checkpointed | `NO_FOR_EACH`: for_each and loop route to pipeline.<br>`NO_RUNTIME_LEAF_ROUTING`: Runtime leaves route to planning-dag. |
| `pipeline` | `flow.target.pipeline@1` | for_each, loop | hybrid | volatile, checkpointed | `RETURN_TO_UNSUPPORTED`: return_to is accepted by the AST but rejected before lowering. |
| `planning-dag` | `flow.target.planning-dag@1` | runtime-leaf | hybrid | volatile, checkpointed | `HOST_HANDLERS_REQUIRED`: Runtime leaf tool names require matching host handlers.<br>`NO_FOR_EACH`: for_each and loop take routing precedence and use pipeline. |

## Validation profiles

| Profile | Gates | Host manifest required |
| --- | --- | --- |
| `authoring-fast` | `parse` → `document-shape` → `output-key-uniqueness` | no |
| `compiler-focused` | `parse` → `document-shape` → `output-key-uniqueness` → `semantic-resolution` → `target-lowering` → `requirement-summary` | no |
| `runtime-fixture` | `parse` → `document-shape` → `output-key-uniqueness` → `semantic-resolution` → `target-lowering` → `requirement-summary` → `host-readiness` → `runtime-fixture` → `evidence-assertions` | yes |
