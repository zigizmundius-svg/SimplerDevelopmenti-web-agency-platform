import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { apiKeys } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { generateApiKey, hashApiKey, previewApiKey } from '@/lib/api-keys';

export async function GET(_req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  const keys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPreview,
      scopes: apiKeys.scopes,
      rateLimitPerMinute: apiKeys.rateLimitPerMinute,
      active: apiKeys.active,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.websiteId, authorized.site.id))
    .orderBy(apiKeys.createdAt);

  // keyPreview is already the display-safe masked form (stored at creation).
  return NextResponse.json({ success: true, data: keys });
}

export async function POST(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  const body = await req.json();
  const name = body.name?.trim() || 'Default';

  const key = generateApiKey();

  const [record] = await db.insert(apiKeys).values({
    clientId: authorized.site.clientId,
    websiteId: authorized.site.id,
    keyHash: hashApiKey(key),
    keyPreview: previewApiKey(key),
    name,
    scopes: body.scopes || [],
    rateLimitPerMinute: body.rateLimitPerMinute || 60,
  }).returning();

  // Return the full key ONCE — caller must save it
  return NextResponse.json({
    success: true,
    data: { id: record.id, name: record.name, key, createdAt: record.createdAt },
  });
}
