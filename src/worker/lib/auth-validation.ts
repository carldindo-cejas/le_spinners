import * as z from 'zod';
import { PASSWORD_ITERATIONS, PASSWORD_SCHEME } from './crypto';

const RELOAD = 'Please reload the page and try again.';
export const zClientHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/, RELOAD);
export const zNewPassword = z.object({
  scheme: z.literal(PASSWORD_SCHEME, { error: RELOAD }),
  iterations: z.literal(PASSWORD_ITERATIONS, { error: RELOAD }),
  salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/, RELOAD),
  clientHash: zClientHash,
});
export const zEmail = z.string().trim().toLowerCase().max(254, 'That email is too long.')
  .pipe(z.email('Enter a valid email address.'));
export const zName = z.string().trim().min(2, 'Enter your full name.').max(80, 'Use at most 80 characters.');
