import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { websiteEnvironments, websiteEnvVars, websiteBackups } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { getEnvironmentForClient, snapshotEnvironment } from '@/lib/environment-helpers';

/** POST - Copy env vars from another environment into this one */
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
  const { env: target } = context;

  const body = await req.json();
  const { fromEnvironmentId } = body;
  if (!fromEnvironmentId) {
    return NextResponse.json({ success: false, message: 'fromEnvironmentId is required' }, { status: 400 });
  }

  const [source] = await db.select().from(websiteEnvironments)
    .where(and(eq(websiteEnvironments.id, fromEnvironmentId), eq(websiteEnvironments.websiteId, authorized.site.id)))
    .limit(1);
  if (!source) return NextResponse.json({ success: false, message: 'Source environment not found' }, { status: 404 });

  const currentSnapshot = await snapshotEnvironment(target.id, authorized.site.id);
  await db.insert(websiteBackups).values({
    environmentId: target.id,
    name: `Auto-backup before copy from ${source.name} — ${new Date().toLocaleString()}`,
    snapshot: currentSnapshot,
    createdBy: authorized.userId,
  });

  const sourceVars = await db.select({ key: websiteEnvVars.key, value: websiteEnvVars.value })
    .from(websiteEnvVars)
    .where(eq(websiteEnvVars.environmentId, source.id));

  await db.delete(websiteEnvVars).where(eq(websiteEnvVars.environmentId, target.id));
  if (sourceVars.length) {
    await db.insert(websiteEnvVars).values(sourceVars.map(v => ({
      environmentId: target.id,
      key: v.key,
      value: v.value,
      syncedToVercel: false,
    })));
  }

  return NextResponse.json({
    success: true,
    message: `Copied ${sourceVars.length} variable${sourceVars.length === 1 ? '' : 's'} from ${source.name}. Sync to Vercel to apply.`,
  });
}
