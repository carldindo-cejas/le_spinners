import * as z from 'zod';
import type { AppContext } from '../types';
import { ApiError, badRequest } from './errors';

function toDetails(error: z.ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', toDetails(result.error));
  }
  return result.data;
}

export async function jsonBody<T extends z.ZodType>(c: AppContext, schema: T): Promise<z.infer<T>> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw badRequest('Send a JSON body.');
  }
  return parse(schema, data);
}

export function query<T extends z.ZodType>(c: AppContext, schema: T): z.infer<T> {
  return parse(schema, c.req.query());
}

// Shared field schemas
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const zActivity = z.enum(['pickleball', 'table_tennis']);
export const zId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid id');
