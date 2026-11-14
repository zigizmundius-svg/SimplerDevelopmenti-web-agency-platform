import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { verifyDomain, resolveDomainProjectId } from '@/lib/vercel';

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

  const site = authorized.site;
  if (!site.domain) {
    return NextResponse.json({ success: false, message: 'No custom domain configured' }, { status: 400 });
  }

  try {
    const projectId = resolveDomainProjectId(site.vercelProjectId);
    const result = await verifyDomain(projectId, site.domain);

    return NextResponse.json({
      success: true,
      data: {
        domain: site.domain,
        verified: result.verified,
        misconfigured: result.misconfigured,
        dnsRecords: result.dnsRecords,
        status: result.verified && !result.misconfigured ? 'active' : 'pending',
      },
      message: result.verified && !result.misconfigured
        ? 'Domain verified and DNS is correctly configured.'
        : result.verified
          ? 'Domain ownership verified but DNS is still misconfigured. Check your DNS records.'
          : 'Domain not yet verified. Make sure your DNS records are set correctly.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
