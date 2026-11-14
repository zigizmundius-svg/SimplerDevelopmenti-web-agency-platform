import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { siteNavigation } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { publishNavItem } from '@/lib/sites/publish-nav';

/**
 * Promote a single nav item's draft to live. Mirrors MCP `nav_publish`.
 * Same semantics: pendingDelete → row deleted; pendingCreate or ordinary
 * update → draft fields applied to live columns and draft cleared.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ siteId: string; itemId: string }> },
) {
  const { siteId, itemId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  const [item] = await db.select({ id: siteNavigation.id })
    .from(siteNavigation)
    .where(and(
      eq(siteNavigation.id, parseInt(itemId, 10)),
      eq(siteNavigation.websiteId, authorized.site.id),
    ))
    .limit(1);
  if (!item) return NextResponse.json({ success: false, message: 'Navigation item not found' }, { status: 404 });

  try {
    const result = await publishNavItem(item.id);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Publish failed';
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
}
