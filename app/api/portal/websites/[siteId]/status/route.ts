import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';

export async function GET(
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

  const site = authorized.site;
  return NextResponse.json({
    success: true,
    data: {
      deploymentStatus: site.deploymentStatus,
      subdomain: site.subdomain,
      fullDomain: site.subdomain ? `${site.subdomain}.simplerdevelopment.com` : null,
      githubRepoName: site.githubRepoName,
      githubRepoUrl: site.githubRepoUrl,
      vercelProjectId: site.vercelProjectId,
      vercelProjectUrl: site.vercelProjectUrl,
      vercelDomain: site.vercelDomain,
      lastDeployedAt: site.lastDeployedAt,
      provisionError: site.provisionError,
    },
  });
}
