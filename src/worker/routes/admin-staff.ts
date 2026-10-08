import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAdmin, roleGuard } from '../lib/auth';
import { createStaff, listStaff, resetStaffPassword, staffCreateSchema, staffListSchema, staffResetSchema, staffUpdateSchema, updateStaff } from '../lib/staff-accounts';
import { jsonBody, parse, query, zId } from '../lib/validate';

export const adminStaffRoutes = new Hono<AppEnv>();
adminStaffRoutes.use('*', roleGuard(requireAdmin));
adminStaffRoutes.get('/', async c => c.json(await listStaff(c, requireAdmin(c), query(c, staffListSchema))));
adminStaffRoutes.post('/', async c => c.json({ staff: await createStaff(c, requireAdmin(c), await jsonBody(c, staffCreateSchema)) }, 201));
adminStaffRoutes.patch('/:id', async c => c.json({ staff: await updateStaff(c, requireAdmin(c), parse(zId, c.req.param('id')), await jsonBody(c, staffUpdateSchema)) }));
adminStaffRoutes.post('/:id/reset-password', async c => c.json({ staff: await resetStaffPassword(c, requireAdmin(c), parse(zId, c.req.param('id')), await jsonBody(c, staffResetSchema)) }));
