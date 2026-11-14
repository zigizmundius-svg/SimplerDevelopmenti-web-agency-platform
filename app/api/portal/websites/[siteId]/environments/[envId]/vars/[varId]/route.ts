import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { getEnvironmentForClient } from '@/lib/environment-helpers';
import { db } from '@/lib/db';
import { websiteEnvVars } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

/** PATCH - Update an env var */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ siteId: string; envId: string; varId: string }> },
) {
  const { siteId, envId, varId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  const context = await getEnvironmentForClient(authorized.userId, siteId, envId);
  if (!context || context.site.id !== authorized.site.id) {
    return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });
  }
  const { env } = context;

  const body = await req.json();
  const updates: Record<string, unknown> = { updatedAt: new Date(), syncedToVercel: false };
  if (body.key !== undefined) {
    if (typeof body.key !== 'string' || !body.key.trim()) {
      return NextResponse.json({ success: false, message: 'key must be a non-empty string' }, { status: 400 });
    }
    updates.key = body.key.trim();
  }
  if (body.value !== undefined) updates.value = String(body.value);

  await db.update(websiteEnvVars)
    .set(updates)
    .where(and(eq(websiteEnvVars.id, parseInt(varId, 10)), eq(websiteEnvVars.environmentId, env.id)));

  return NextResponse.json({ success: true, message: 'Updated.' });
}

/** DELETE - Remove an env var */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ siteId: string; envId: string; varId: string }> },
) {
  const { siteId, envId, varId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  const context = await getEnvironmentForClient(authorized.userId, siteId, envId);
  if (!context || context.site.id !== authorized.site.id) {
    return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });
  }
  const { env } = context;

  await db.delete(websiteEnvVars)
    .where(and(eq(websiteEnvVars.id, parseInt(varId, 10)), eq(websiteEnvVars.environmentId, env.id)));

  return NextResponse.json({ success: true, message: 'Deleted.' });
}
