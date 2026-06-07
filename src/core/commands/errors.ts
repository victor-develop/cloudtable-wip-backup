export class CommandCommitError extends Error {
  readonly diagnostic: string;

  constructor(diagnostic: string) {
    super(diagnostic);
    this.name = "CommandCommitError";
    this.diagnostic = diagnostic;
  }
}

export function isCommandCommitError(error: unknown): error is CommandCommitError {
  return error instanceof CommandCommitError;
}
