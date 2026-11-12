import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { getEnvironmentForClient } from '@/lib/environment-helpers';
import { db } from '@/lib/db';
import { websiteBackups, websiteEnvVars } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { snapshotEnvironment } from '@/lib/environment-helpers';

/** POST - Restore an environment from a backup */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string; envId: string }> },
) {
  const { siteId, envId } = await params;
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
  const { backupId } = body;
  if (!backupId) {
    return NextResponse.json({ success: false, message: 'backupId is required' }, { status: 400 });
  }

  const [backup] = await db.select().from(websiteBackups)
    .where(and(eq(websiteBackups.id, backupId), eq(websiteBackups.environmentId, env.id)))
    .limit(1);
  if (!backup) return NextResponse.json({ success: false, message: 'Backup not found' }, { status: 404 });

  const currentSnapshot = await snapshotEnvironment(env.id, authorized.site.id);
  await db.insert(websiteBackups).values({
    environmentId: env.id,
    name: `Auto-backup before restore — ${new Date().toLocaleString()}`,
    snapshot: currentSnapshot,
    createdBy: authorized.userId,
  });

  const snapshot = backup.snapshot as { envVars: Array<{ key: string; value: string }> };
  await db.delete(websiteEnvVars).where(eq(websiteEnvVars.environmentId, env.id));
  if (snapshot.envVars?.length) {
    await db.insert(websiteEnvVars).values(snapshot.envVars.map(v => ({
      environmentId: env.id,
      key: v.key,
      value: v.value,
      syncedToVercel: false,
    })));
  }

  return NextResponse.json({ success: true, message: 'Environment restored from backup. Env vars need to be synced to Vercel.' });
}
