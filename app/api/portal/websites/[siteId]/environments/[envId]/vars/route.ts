import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { getEnvironmentForClient } from '@/lib/environment-helpers';
import { db } from '@/lib/db';
import { websiteEnvVars, websiteEnvironments } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

/** GET - List env vars for an environment (values may contain secrets) */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string; envId: string }> },
) {
  const { siteId, envId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  const context = await getEnvironmentForClient(authorized.userId, siteId, envId);
  if (!context || context.site.id !== authorized.site.id) {
    return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });
  }
  const { env } = context;

  const vars = await db.select().from(websiteEnvVars)
    .where(eq(websiteEnvVars.environmentId, env.id))
    .orderBy(websiteEnvVars.key);

  return NextResponse.json({ success: true, data: vars });
}

/** POST - Add a new env var */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string; envId: string }> },
) {
  const { siteId, envId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  const context = await getEnvironmentForClient(authorized.userId, siteId, envId);
  if (!context || context.site.id !== authorized.site.id) {
    return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });
  }
  const { env } = context;

  const body = await req.json();
  const { key, value } = body;
  if (!key || typeof key !== 'string') {
    return NextResponse.json({ success: false, message: 'key is required' }, { status: 400 });
  }
  if (value === undefined || value === null) {
    return NextResponse.json({ success: false, message: 'value is required' }, { status: 400 });
  }

  const [newVar] = await db.insert(websiteEnvVars)
    .values({ environmentId: env.id, key: key.trim(), value: String(value) })
    .returning();

  return NextResponse.json({ success: true, data: newVar });
}
