import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { githubConnections } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { addCollaborator } from '@/lib/github';

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

  if (!authorized.site.githubRepoName) {
    return NextResponse.json({ success: false, message: 'Website repo has not been provisioned yet.' }, { status: 400 });
  }

  const [ghConn] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.userId, authorized.userId))
    .limit(1);

  if (!ghConn) {
    return NextResponse.json({ success: false, message: 'Connect your GitHub account first.' }, { status: 400 });
  }

  const body = await req.json();
  const permission = body.permission === 'admin' ? 'admin' : 'push';

  try {
    await addCollaborator(authorized.site.githubRepoName, ghConn.githubUsername, permission);
    return NextResponse.json({ success: true, message: `Added ${ghConn.githubUsername} as collaborator.` });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to add collaborator';
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
