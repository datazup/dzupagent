// Alternative pure handler for primitive://adapter.run@2 (dzupagent-run fixture).
export default function adapterRunLocalAlt(invocation) {
  return {
    status: "success",
    outputs: {
      result: { text: `${invocation.stepId}-alt` },
      receipt: { digest: `${invocation.stepId}-alt-digest` },
    },
    durationMs: 10,
    costCents: 1,
  };
}
