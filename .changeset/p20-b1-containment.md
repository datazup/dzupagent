---
"@dzupagent/agent-adapters": minor
---

Add an opt-in `containment` option to `CodexAppServerStdioClient` that runs the
app-server inside a bubblewrap PID namespace and exposes `joinReceipt()`. The
receipt is `joined` only after the outer process exits without a signal, which
the kernel guarantees happens after every descendant has been reaped. Network
effects are outside the receipt.
