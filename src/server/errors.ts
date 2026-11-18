/** Typed application error. Services throw this; transport layers map `status` to HTTP. */
export type ErrorCode =
  | "SLOT_UNAVAILABLE" | "NOT_FOUND" | "VALIDATION" | "FORBIDDEN" | "UNAUTHORIZED"
  | "CONFLICT" | "RATE_LIMITED" | "INVALID_STATE" | "INTERNAL" | (string & {});

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
