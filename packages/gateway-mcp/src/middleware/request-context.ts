/**
 * Request context middleware — adds request ID, structured access logging,
 * and correlation headers for production observability.
 */

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { Logger } from 'pino';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      startTime?: number;
    }
  }
}

export function requestContextMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Use incoming request ID or generate one
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    req.requestId = requestId;
    req.startTime = Date.now();

    // Set response headers
    res.setHeader('X-Request-ID', requestId);

    // Access log on response finish
    res.on('finish', () => {
      const duration = Date.now() - (req.startTime ?? Date.now());
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level]({
        req_id: requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
        org_id: req.orgId,
        ip: req.ip,
        user_agent: req.headers['user-agent']?.substring(0, 80),
      }, `${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });

    next();
  };
}
