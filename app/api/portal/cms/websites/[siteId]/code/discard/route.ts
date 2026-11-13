import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { discardSiteCustomCodeDraft } from '@/lib/sites/publish-custom-code';

/**
 * Clears the draft custom CSS/JS without touching live. Only site admins may
 * discard code; the write is tenant-scoped again inside the helper.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId: siteIdRaw } = await params;
  const siteId = Number.parseInt(siteIdRaw, 10);
  if (!Number.isSafeInteger(siteId) || siteId <= 0) {
    return NextResponse.json({ success: false, message: 'Invalid site id' }, { status: 400 });
  }

  const authorized = await authorizePortalSite({ siteId, action: 'admin', observeRole: false });
  if (isAuthError(authorized)) return authorized.response;

  await discardSiteCustomCodeDraft(authorized.site.id, authorized.client.id);

  return NextResponse.json({
    success: true,
    data: {
      customCss: authorized.site.customCss || '',
      customJs: authorized.site.customJs || '',
      draftCustomCss: null,
      draftCustomJs: null,
      draftUpdatedAt: null,
      draftUpdatedBy: null,
      hasDraft: false,
    },
  });
}
