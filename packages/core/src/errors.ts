export class BoardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BoardError";
    this.code = code;
  }
}

export function isBoardError(err: unknown): err is BoardError {
  return err instanceof BoardError;
}
