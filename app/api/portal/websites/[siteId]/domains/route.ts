import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { clientWebsites, websiteDomains } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { addDomain, getDomainConfig, resolveDomainProjectId } from '@/lib/vercel';

/** GET - List all domains for a website */
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

  const domains = await db.select().from(websiteDomains)
    .where(eq(websiteDomains.websiteId, authorized.site.id))
    .orderBy(websiteDomains.createdAt);

  return NextResponse.json({ success: true, data: domains });
}

/** POST - Add a new custom domain */
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
  const { site } = authorized;

  let projectId: string;
  try {
    projectId = resolveDomainProjectId(site.vercelProjectId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Platform Vercel project is not configured.';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }

  const body = await req.json();
  const { domain: rawDomain } = body;
  if (!rawDomain || typeof rawDomain !== 'string') {
    return NextResponse.json({ success: false, message: 'domain is required.' }, { status: 400 });
  }

  const cleanDomain = rawDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
  const [existing] = await db.select().from(websiteDomains)
    .where(and(eq(websiteDomains.websiteId, site.id), eq(websiteDomains.domain, cleanDomain)))
    .limit(1);
  if (existing) {
    return NextResponse.json({ success: false, message: 'This domain is already added.' }, { status: 409 });
  }

  try {
    await addDomain(projectId, cleanDomain);
    let cnameTarget = 'cname.vercel-dns.com';
    try {
      const config = await getDomainConfig(cleanDomain);
      if (config.cnames[0]) cnameTarget = config.cnames[0];
    } catch {
      // Fall back to the generic target — Vercel accepts it.
    }

    const existingDomains = await db.select().from(websiteDomains)
      .where(eq(websiteDomains.websiteId, site.id))
      .limit(1);
    const isPrimary = existingDomains.length === 0;
    const [newDomain] = await db.insert(websiteDomains).values({
      websiteId: site.id,
      domain: cleanDomain,
      isPrimary,
      status: 'pending',
    }).returning();

    if (isPrimary) {
      await db.update(clientWebsites)
        .set({ domain: cleanDomain, updatedAt: new Date() })
        .where(eq(clientWebsites.id, site.id));
    }

    const isApex = cleanDomain.split('.').length <= 2;
    const dnsInstructions = isApex
      ? [
          { type: 'A', host: '@', value: '76.76.21.21', notes: `Points ${cleanDomain} to Vercel` },
          { type: 'CNAME', host: 'www', value: cnameTarget, notes: `Points www.${cleanDomain} to Vercel` },
        ]
      : [
          { type: 'CNAME', host: cleanDomain.split('.')[0], value: cnameTarget, notes: `Points ${cleanDomain} to Vercel` },
        ];

    return NextResponse.json({ success: true, data: { ...newDomain, dnsInstructions } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to add domain';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
