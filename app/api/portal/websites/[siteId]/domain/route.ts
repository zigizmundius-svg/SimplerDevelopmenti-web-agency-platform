import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { clientWebsites } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { addDomain } from '@/lib/vercel';
import { normalizeCustomDomain } from '@/lib/normalize-domain';

export async function POST(
  req: Request,
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
  if (!site.vercelProjectId) {
    return NextResponse.json({ success: false, message: 'Website must be provisioned before adding a custom domain.' }, { status: 400 });
  }

  const body = await req.json();
  const { customDomain } = body;

  if (!customDomain || typeof customDomain !== 'string') {
    return NextResponse.json({ success: false, message: 'customDomain is required.' }, { status: 400 });
  }

  const cleanDomain = normalizeCustomDomain(customDomain);

  try {
    await addDomain(site.vercelProjectId, cleanDomain);

    await db.update(clientWebsites)
      .set({ domain: cleanDomain, updatedAt: new Date() })
      .where(eq(clientWebsites.id, site.id));

    return NextResponse.json({
      success: true,
      data: {
        domain: cleanDomain,
        dnsInstructions: [
          { type: 'CNAME', host: 'www', value: 'cname.vercel-dns.com', notes: 'Points www subdomain to Vercel' },
          { type: 'A', host: '@', value: '76.76.21.21', notes: 'Points root domain to Vercel' },
        ],
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to add domain';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
