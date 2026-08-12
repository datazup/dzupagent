export class GoldenTraceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenTraceValidationError";
  }
}
