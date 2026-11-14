import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { auth } from '@/lib/auth';
import {
  IMPERSONATE_COOKIE,
  getImpersonatedClientIdFromToken,
} from '@/lib/impersonation';

/**
 * Stop impersonation. Clears the `sd_impersonate_client_id` cookie and
 * redirects back to /admin/clients/[id] (when `redirect=1`).
 *
 * Anyone with a valid session can call this; clearing the cookie is safe.
 * (We additionally log the action when the caller is staff.)
 */
export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  const role = (session?.user as { role?: string } | undefined)?.role;

  const store = await cookies();
  const tokenVal = store.get(IMPERSONATE_COOKIE)?.value;

  // Best-effort: figure out where to redirect (back to the admin client page),
  // but only trust a cookie minted for this exact staff identity.
  let targetClientId: number | null = null;
  const staffUserId = userId ? Number.parseInt(userId, 10) : Number.NaN;
  if (Number.isSafeInteger(staffUserId) && staffUserId > 0) {
    targetClientId = getImpersonatedClientIdFromToken(tokenVal, role, staffUserId);
  }

  if (targetClientId != null) {
    console.log('[impersonation] stop', {
      staffUserId,
      targetClientId,
      timestamp: new Date().toISOString(),
      action: 'stop',
    });
  }

  const url = new URL(req.url);
  const wantRedirect = url.searchParams.get('redirect') === '1';
  const redirectTo = targetClientId != null
    ? `/admin/clients/${targetClientId}`
    : '/admin/clients';

  if (wantRedirect) {
    const res = NextResponse.redirect(new URL(redirectTo, req.url), { status: 303 });
    res.cookies.set(IMPERSONATE_COOKIE, '', {
      path: '/',
      expires: new Date(0),
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    return res;
  }

  const res = NextResponse.json({ success: true, data: { redirectTo } });
  res.cookies.set(IMPERSONATE_COOKIE, '', {
    path: '/',
    expires: new Date(0),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
  return res;
}
