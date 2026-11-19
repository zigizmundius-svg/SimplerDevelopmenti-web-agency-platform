import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { publishAllNavDrafts } from '@/lib/sites/publish-nav';

/**
 * Promote every nav row with a non-null draft on the site. Mirrors MCP
 * `nav_publish_all`. Per-row semantics: pendingDelete → row deleted;
 * pendingCreate or ordinary update → draft fields applied to live, draft
 * cleared.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const { siteId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  try {
    const result = await publishAllNavDrafts(authorized.site.id);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Publish failed';
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
}
