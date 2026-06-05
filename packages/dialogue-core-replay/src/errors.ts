export type RecordedPortName = "agent" | "validator" | "workspace";

export class ReplayExhaustedError extends Error {
  readonly portName: RecordedPortName;
  readonly methodName: string;
  readonly callIndex: number;

  constructor(portName: RecordedPortName, methodName: string, callIndex: number) {
    super(
      `Replay recording exhausted for ${portName}.${methodName} at call index ${callIndex}.`,
    );
    this.name = "ReplayExhaustedError";
    this.portName = portName;
    this.methodName = methodName;
    this.callIndex = callIndex;
  }
}
