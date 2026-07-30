export class ZCodeError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly details: string[] = [],
  ) {
    super(message ? `${code}:${message}` : code);
    this.name = 'ZCodeError';
  }
}

export const errorCode = (error: unknown): string =>
  error instanceof ZCodeError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
