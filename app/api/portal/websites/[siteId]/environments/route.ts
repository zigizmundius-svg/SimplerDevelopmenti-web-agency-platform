import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { websiteEnvironments } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

/** GET - List environments for a website */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const { siteId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'read',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  const envs = await db.select().from(websiteEnvironments)
    .where(eq(websiteEnvironments.websiteId, authorized.site.id))
    .orderBy(websiteEnvironments.name);

  return NextResponse.json({ success: true, data: envs });
}
