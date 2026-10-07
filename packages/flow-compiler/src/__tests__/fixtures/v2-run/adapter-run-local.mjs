// Pure provider-free handler for primitive://adapter.run@2 (dzupagent-run fixture).
export default function adapterRunLocal(invocation) {
  return {
    status: "success",
    outputs: {
      result: { text: `${invocation.stepId}-done` },
      receipt: { digest: `${invocation.stepId}-digest` },
    },
    durationMs: 10,
    costCents: 1,
  };
}
