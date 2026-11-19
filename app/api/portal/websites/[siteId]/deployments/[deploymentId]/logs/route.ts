import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { getDeploymentEvents } from '@/lib/vercel';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string; deploymentId: string }> },
) {
  const { siteId, deploymentId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  if (!authorized.site.vercelProjectId) {
    return NextResponse.json({ success: false, message: 'Website not provisioned' }, { status: 400 });
  }

  try {
    const events = await getDeploymentEvents(deploymentId);
    return NextResponse.json({ success: true, data: events });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch logs';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
