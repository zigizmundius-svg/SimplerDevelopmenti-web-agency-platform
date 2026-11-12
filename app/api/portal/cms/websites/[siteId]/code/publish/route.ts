import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { publishSiteCustomCode } from '@/lib/sites/publish-custom-code';

/**
 * Publishes the draft custom CSS/JS to live and clears the draft.
 * Mirrors MCP `sites_publish_custom_code`. The same `publishSiteCustomCode`
 * helper is intended to be reused by the MCP approvals `site:publish` case
 * in a follow-up commit.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const authorized = await authorizePortalSite({ siteId: parseInt(siteId, 10), action: 'admin', observeRole: false });
  if (isAuthError(authorized)) return authorized.response;
  const { site } = authorized;

  // Refuse no-op publishes so a stray button-click can't silently overwrite
  // live with identical values (also keeps `updatedAt` honest).
  const draftMatchesLive =
    (site.draftCustomCss ?? null) === (site.customCss ?? null) &&
    (site.draftCustomJs ?? null) === (site.customJs ?? null);
  const noDraft = site.draftCustomCss === null && site.draftCustomJs === null;
  if (noDraft || draftMatchesLive) {
    return NextResponse.json(
      { success: false, message: 'No draft changes to publish.' },
      { status: 400 },
    );
  }

  const result = await publishSiteCustomCode(site.id);

  return NextResponse.json({
    success: true,
    data: {
      customCss: result.customCss,
      customJs: result.customJs,
      draftCustomCss: null,
      draftCustomJs: null,
      draftUpdatedAt: null,
      draftUpdatedBy: null,
      hasDraft: false,
    },
  });
}
