import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';

/** Standard API error response envelope */
export interface ApiError {
  error: {
    code: string;
    message: string;
    request_id?: string;
    details?: unknown;
  };
}

export function createErrorMiddleware(logger: Logger) {
  return function errorMiddleware(
    err: Error & { statusCode?: number; code?: string },
    req: Request,
    res: Response,
    _next: NextFunction
  ) {
    if (res.headersSent) return _next(err);

    const statusCode = err.statusCode ?? 500;
    const isServerError = statusCode >= 500;
    const code = err.code ?? (isServerError ? 'INTERNAL_ERROR' : 'BAD_REQUEST');

    logger.error({
      err,
      req_id: req.requestId,
      method: req.method,
      path: req.path,
      status: statusCode,
      org_id: req.orgId,
    }, `Unhandled error: ${err.message}`);

    const body: ApiError = {
      error: {
        code,
        message: isServerError ? 'Internal server error' : err.message,
        request_id: req.requestId,
      },
    };

    res.status(statusCode).json(body);
  };
}

/** Helper: throw with status code */
export class HttpError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
