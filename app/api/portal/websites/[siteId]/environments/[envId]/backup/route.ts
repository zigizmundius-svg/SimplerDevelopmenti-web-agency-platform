import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { websiteBackups, websiteEnvironments } from '@/lib/db/schema';
import { and, eq, desc } from 'drizzle-orm';
import { snapshotEnvironment } from '@/lib/environment-helpers';

/** GET - List backups for an environment */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string; envId: string }> },
) {
  const { siteId, envId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'read',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  const [env] = await db.select().from(websiteEnvironments)
    .where(and(eq(websiteEnvironments.id, parseInt(envId, 10)), eq(websiteEnvironments.websiteId, authorized.site.id)))
    .limit(1);
  if (!env) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });

  const backups = await db.select({
    id: websiteBackups.id,
    name: websiteBackups.name,
    createdAt: websiteBackups.createdAt,
  }).from(websiteBackups)
    .where(eq(websiteBackups.environmentId, env.id))
    .orderBy(desc(websiteBackups.createdAt))
    .limit(20);

  return NextResponse.json({ success: true, data: backups });
}

/** POST - Create a backup of the current environment state */
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

  const [env] = await db.select().from(websiteEnvironments)
    .where(and(eq(websiteEnvironments.id, parseInt(envId, 10)), eq(websiteEnvironments.websiteId, authorized.site.id)))
    .limit(1);
  if (!env) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const name = body.name || `${env.name} backup — ${new Date().toLocaleString()}`;
  const snapshot = await snapshotEnvironment(env.id, authorized.site.id);

  const [backup] = await db.insert(websiteBackups).values({
    environmentId: env.id,
    name,
    snapshot,
    createdBy: authorized.userId,
  }).returning();

  return NextResponse.json({ success: true, data: { id: backup.id, name: backup.name }, message: 'Backup created.' });
}
