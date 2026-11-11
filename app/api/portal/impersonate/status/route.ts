import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { clients } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  IMPERSONATE_COOKIE,
  getImpersonatedClientIdFromToken,
} from '@/lib/impersonation';

/**
 * Returns whether the current request is being made under an active
 * impersonation session, and (if so) the target client's display info for the
 * portal banner.
 *
 * Always returns 200 with `{ success: true, data: { active, ... } }` so the
 * banner can render unconditionally on every portal page without error
 * handling noise.
 */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  const role = (session?.user as { role?: string } | undefined)?.role;

  // Default response (no impersonation).
  const inactive = NextResponse.json({
    success: true,
    data: { active: false as const },
  });

  // The banner is only active for the staff identity that minted the cookie.
  if (!userId) return inactive;
  const staffUserId = Number.parseInt(userId, 10);
  if (!Number.isSafeInteger(staffUserId) || staffUserId <= 0) return inactive;

  const store = await cookies();
  const tokenVal = store.get(IMPERSONATE_COOKIE)?.value;
  const targetClientId = getImpersonatedClientIdFromToken(tokenVal, role, staffUserId);
  if (targetClientId == null) return inactive;

  const [row] = await db
    .select({ id: clients.id, company: clients.company })
    .from(clients)
    .where(eq(clients.id, targetClientId))
    .limit(1);

  if (!row) return inactive;

  return NextResponse.json({
    success: true,
    data: {
      active: true as const,
      clientId: row.id,
      clientCompany: row.company ?? `Client #${row.id}`,
    },
  });
}
