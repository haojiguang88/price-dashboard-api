export class WorkspaceCenterError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const getWorkspaceCenterStatusCode = (error: unknown, fallback = 500) => (
  error instanceof WorkspaceCenterError ? error.statusCode : fallback
);

export const isUniqueConstraintError = (error: unknown) => (
  String((error as Error)?.message || '').includes('UNIQUE')
);
