import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { apiKeys } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

export async function DELETE(_req: Request, { params }: { params: Promise<{ siteId: string; keyId: string }> }) {
  const { siteId, keyId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  await db.delete(apiKeys).where(and(
    eq(apiKeys.id, parseInt(keyId, 10)),
    eq(apiKeys.websiteId, authorized.site.id),
  ));

  return NextResponse.json({ success: true });
}
