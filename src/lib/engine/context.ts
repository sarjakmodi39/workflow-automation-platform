export interface ExecutionContext {
  /** The run's initial input. */
  input: unknown;
  /** Outputs of completed steps, keyed by step id. */
  steps: Record<string, unknown>;
}

export function emptyContext(input: unknown): ExecutionContext {
  return { input, steps: {} };
}
