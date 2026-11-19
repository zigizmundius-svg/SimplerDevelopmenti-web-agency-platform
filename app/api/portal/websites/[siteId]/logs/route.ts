import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { httpRequestLogs } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const { siteId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  const { searchParams } = new URL(req.url);
  const requestedLimit = parseInt(searchParams.get('limit') || '50', 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;

  const logs = await db.select().from(httpRequestLogs)
    .where(eq(httpRequestLogs.websiteId, authorized.site.id))
    .orderBy(desc(httpRequestLogs.createdAt))
    .limit(limit);

  return NextResponse.json({ success: true, data: logs });
}
