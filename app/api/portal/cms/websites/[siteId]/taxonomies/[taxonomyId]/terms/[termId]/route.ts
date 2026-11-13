import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { auth } from '@/lib/auth';
import { getPortalClient } from '@/lib/portal-client';
import { db } from '@/lib/db';
import { clientWebsites, taxonomies, taxonomyTerms } from '@/lib/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';

async function verifyTermAccess(siteId: string, taxonomyId: string, termId: string) {
  const session = await auth();
  if (!session?.user?.id) return null;
  const userId = parseInt(session.user.id, 10);
  const client = await getPortalClient(userId);
  if (!client) return null;

  const [site] = await db
    .select({ id: clientWebsites.id })
    .from(clientWebsites)
    .where(and(eq(clientWebsites.id, parseInt(siteId)), eq(clientWebsites.clientId, client.id)))
    .limit(1);
  if (!site) return null;

  const [taxonomy] = await db
    .select()
    .from(taxonomies)
    .where(and(
      eq(taxonomies.id, parseInt(taxonomyId)),
      or(eq(taxonomies.websiteId, site.id), and(eq(taxonomies.builtIn, true), isNull(taxonomies.websiteId)))
    ))
    .limit(1);
  if (!taxonomy) return null;

  const [term] = await db
    .select()
    .from(taxonomyTerms)
    .where(and(eq(taxonomyTerms.id, parseInt(termId)), eq(taxonomyTerms.taxonomyId, taxonomy.id)))
    .limit(1);

  return term ? { site, taxonomy, term } : null;
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ siteId: string; taxonomyId: string; termId: string }> },
) {
  const { siteId, taxonomyId, termId } = await params;
  const authorization = await authorizePortalSite({ siteId: Number.parseInt(siteId, 10), action: 'write', observeRole: false });
  if (isAuthError(authorization)) return authorization.response;
  const access = await verifyTermAccess(siteId, taxonomyId, termId);
  if (!access) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });
  if (access.taxonomy.websiteId !== access.site.id || access.taxonomy.builtIn) {
    return NextResponse.json({ success: false, message: 'Global built-in taxonomies are read-only. Create a site-specific taxonomy to customize terms.' }, { status: 403 });
  }

  const body = await req.json();

  if (body.parentId !== undefined && body.parentId !== null) {
    if (!Number.isSafeInteger(body.parentId) || body.parentId <= 0 || body.parentId === access.term.id) {
      return NextResponse.json({ success: false, message: 'parentId must reference another term in this taxonomy.' }, { status: 400 });
    }
    const [parent] = await db.select({ id: taxonomyTerms.id })
      .from(taxonomyTerms)
      .where(and(eq(taxonomyTerms.id, body.parentId), eq(taxonomyTerms.taxonomyId, access.taxonomy.id)))
      .limit(1);
    if (!parent) {
      return NextResponse.json({ success: false, message: 'parentId must reference a term in this taxonomy.' }, { status: 400 });
    }
  }

  const [updated] = await db
    .update(taxonomyTerms)
    .set({
      name: body.name ?? access.term.name,
      slug: body.slug ?? access.term.slug,
      description: body.description !== undefined ? (body.description || null) : access.term.description,
      color: body.color !== undefined ? (body.color || null) : access.term.color,
      parentId: body.parentId !== undefined ? (body.parentId || null) : access.term.parentId,
    })
    .where(eq(taxonomyTerms.id, access.term.id))
    .returning();

  return NextResponse.json({ success: true, data: updated });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ siteId: string; taxonomyId: string; termId: string }> },
) {
  const { siteId, taxonomyId, termId } = await params;
  const authorization = await authorizePortalSite({ siteId: Number.parseInt(siteId, 10), action: 'write', observeRole: false });
  if (isAuthError(authorization)) return authorization.response;
  const access = await verifyTermAccess(siteId, taxonomyId, termId);
  if (access.taxonomy.websiteId !== access.site.id || access.taxonomy.builtIn) {
    return NextResponse.json({ success: false, message: 'Global built-in taxonomies are read-only. Create a site-specific taxonomy to customize terms.' }, { status: 403 });
  }
  if (!access) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });

  await db.delete(taxonomyTerms).where(eq(taxonomyTerms.id, access.term.id));
  return NextResponse.json({ success: true });
}
