export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}
export function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}
