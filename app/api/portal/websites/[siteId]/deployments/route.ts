import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { getDeployments } from '@/lib/vercel';

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

  if (!authorized.site.vercelProjectId) {
    return NextResponse.json({ success: true, data: [] });
  }

  try {
    const deployments = await getDeployments(authorized.site.vercelProjectId);
    return NextResponse.json({ success: true, data: deployments });
  } catch {
    return NextResponse.json({ success: true, data: [], message: 'Could not fetch deployments' });
  }
}
