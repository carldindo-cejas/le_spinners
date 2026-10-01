import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** An error that is safe to show the client: a stable code plus a human message. */
export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message = 'Bad request', details?: Record<string, unknown>) =>
  new ApiError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Please sign in to continue.') =>
  new ApiError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = "You don't have access to this.") =>
  new ApiError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found.') => new ApiError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(422, code, message, details);
export const tooMany = (message = 'Too many attempts. Please wait a few minutes and try again.') =>
  new ApiError(429, 'RATE_LIMITED', message);
