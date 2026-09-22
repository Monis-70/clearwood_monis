/**
 * R4 — the single typed error class. Anything thrown that is not an AppError (or a ZodError, or a
 * known Prisma error) is treated as an unexpected 500 and its message is never leaked to a client
 * in production.
 */
export class AppError extends Error {
  readonly statusCode: number;
  /** SNAKE_CASE machine code echoed in the response envelope. */
  readonly code: string;
  readonly details: unknown | null;
  /** `false` marks a bug rather than a handled business condition. */
  readonly isOperational: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: unknown = null,
    isOperational = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message: string, code = 'BAD_REQUEST', details: unknown = null): AppError {
    return new AppError(400, code, message, details);
  }

  static unauthorized(message = 'Authentication required', details: unknown = null): AppError {
    return new AppError(401, 'UNAUTHORIZED', message, details);
  }

  static forbidden(message = 'You do not have access to this resource', details: unknown = null) {
    return new AppError(403, 'FORBIDDEN', message, details);
  }

  static notFound(message = 'Resource not found', details: unknown = null): AppError {
    return new AppError(404, 'NOT_FOUND', message, details);
  }

  static conflict(message: string, details: unknown = null): AppError {
    return new AppError(409, 'CONFLICT', message, details);
  }

  /** R2 — invalid input is always 422. */
  static validation(message = 'Validation failed', details: unknown = null): AppError {
    return new AppError(422, 'VALIDATION_ERROR', message, details);
  }

  static tooManyRequests(message = 'Too many requests', details: unknown = null): AppError {
    return new AppError(429, 'RATE_LIMITED', message, details);
  }

  static serviceUnavailable(message: string, details: unknown = null): AppError {
    return new AppError(503, 'SERVICE_UNAVAILABLE', message, details);
  }

  static internal(message = 'Something went wrong', details: unknown = null): AppError {
    return new AppError(500, 'INTERNAL_SERVER_ERROR', message, details, false);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
