import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/AppError.ts';

/**
 * Request validation convention (contracts §5, INV-02).
 *
 * Schemas are built with `strictObject`, so unknown fields are rejected rather
 * than silently dropped. Establishing this in Phase 1 means later phases add
 * routes to an existing convention instead of retrofitting one.
 */
export const strictObject = z.strictObject;

/** Flattens Zod issues into a safe `details` payload: field paths and messages only. */
function toDetails(error: z.ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/**
 * Parses a value against a schema, throwing a canonical `VALIDATION` error.
 * Use directly when the value isn't an Express request part.
 */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw AppError.validation('Request validation failed', toDetails(result.error));
  }
  return result.data;
}

/** Validates `req.body` and replaces it with the parsed, typed result. */
export function validateBody<T extends z.ZodType>(schema: T): RequestHandler {
  return (req, _res, next) => {
    req.body = parseOrThrow(schema, req.body);
    next();
  };
}

/** Validates `req.query`. Express 5 exposes a getter-only `query`, so the result is stashed. */
export function validateQuery<T extends z.ZodType>(schema: T): RequestHandler {
  return (req, res, next) => {
    res.locals['query'] = parseOrThrow(schema, req.query);
    next();
  };
}

/** Validates `req.params`. */
export function validateParams<T extends z.ZodType>(schema: T): RequestHandler {
  return (req, res, next) => {
    res.locals['params'] = parseOrThrow(schema, req.params);
    next();
  };
}
