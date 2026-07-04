/** Thrown when a schema-declared feature has no v1 implementation (e.g. simulated scenarios). */
export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented in this version`);
    this.name = 'NotImplementedError';
  }
}

/** Thrown for invalid runner/CLI configuration (missing adapter factory, unknown judge ref, ...). */
export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalConfigError';
  }
}
