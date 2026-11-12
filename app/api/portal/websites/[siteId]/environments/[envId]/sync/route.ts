import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { getEnvironmentForClient } from '@/lib/environment-helpers';
import { db } from '@/lib/db';
import { websiteEnvVars, websiteEnvironments } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { setEnvVars } from '@/lib/vercel';
import { requireService } from '@/lib/mcp/types';

/** POST - Sync all env vars to Vercel for this environment's target */
export async function POST(
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

  if (!(await requireService(authorized.site.clientId, 'websites'))) {
    return NextResponse.json(
      { success: false, message: 'Your plan does not include hosting. Upgrade to sync environment variables.' },
      { status: 403 },
    );
  }

  if (!authorized.site.vercelProjectId) {
    return NextResponse.json({ success: false, message: 'Website must be provisioned first' }, { status: 400 });
  }

  const vars = await db.select().from(websiteEnvVars)
    .where(eq(websiteEnvVars.environmentId, env.id));
  if (vars.length === 0) {
    return NextResponse.json({ success: true, message: 'No env vars to sync.' });
  }

  try {
    await setEnvVars(
      authorized.site.vercelProjectId,
      vars.map(v => ({ key: v.key, value: v.value, target: [env.vercelTarget] })),
    );

    console.info('[env-sync] vercel env vars synced', {
      actorUserId: authorized.userId,
      clientId: authorized.site.clientId,
      siteId,
      envId,
      target: env.vercelTarget,
      keys: vars.map(v => v.key),
    });

    for (const v of vars) {
      await db.update(websiteEnvVars)
        .set({ syncedToVercel: true, updatedAt: new Date() })
        .where(eq(websiteEnvVars.id, v.id));
    }

    return NextResponse.json({
      success: true,
      message: `${vars.length} variable${vars.length === 1 ? '' : 's'} synced to Vercel (${env.vercelTarget}).`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
