import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { clientWebsites } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { provisionWebsite } from '@/lib/website-provisioner';
import { generateUniqueSubdomain } from '@/lib/subdomain';

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

  const { site, client } = authorized;
  if (site.deploymentStatus === 'provisioning') {
    return NextResponse.json({ success: false, message: 'Provisioning is already in progress.' }, { status: 409 });
  }

  const isManaged = site.deploymentStatus === 'active' && !site.githubRepoName && !site.vercelProjectId;
  if (site.deploymentStatus === 'active' && !isManaged) {
    return NextResponse.json({ success: false, message: 'Website is already provisioned.' }, { status: 409 });
  }

  let subdomain = site.subdomain;
  if (!subdomain) {
    subdomain = await generateUniqueSubdomain(client.company || 'site', site.name);
    await db.update(clientWebsites)
      .set({ subdomain, updatedAt: new Date() })
      .where(eq(clientWebsites.id, site.id));
  }

  provisionWebsite(site.id, subdomain, site.description || site.name).catch(() => {
    // Error already persisted to DB by provisionWebsite
  });

  return NextResponse.json({
    success: true,
    data: { siteId: site.id, subdomain, status: 'provisioning' },
  });
}
