import { NextResponse } from 'next/server';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { internalJobs } from '@/lib/db/schema';

async function requireStaff() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const role = (session.user as { role?: string })?.role;
  if (role !== 'admin' && role !== 'employee') return null;
  return session;
}

export async function GET(req: Request) {
  if (!(await requireStaff())) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const requestedStatus = searchParams.get('status');
  const allowed = ['pending', 'running', 'completed', 'dead_letter'] as const;
  const status = allowed.includes(requestedStatus as typeof allowed[number])
    ? requestedStatus as typeof allowed[number]
    : null;

  const rows = await db.select({
    id: internalJobs.id,
    clientId: internalJobs.clientId,
    type: internalJobs.type,
    status: internalJobs.status,
    attemptCount: internalJobs.attemptCount,
    nextRetryAt: internalJobs.nextRetryAt,
    error: internalJobs.error,
    dedupeKey: internalJobs.dedupeKey,
    createdAt: internalJobs.createdAt,
    processedAt: internalJobs.processedAt,
  }).from(internalJobs)
    .where(status ? eq(internalJobs.status, status) : sql`true`)
    .orderBy(desc(internalJobs.createdAt))
    .limit(150);

  const counts = await Promise.all(allowed.map(async (value) => {
    const [row] = await db.select({ count: count() }).from(internalJobs)
      .where(eq(internalJobs.status, value));
    return [value, row?.count ?? 0] as const;
  }));

  return NextResponse.json({
    success: true,
    data: rows,
    counts: Object.fromEntries(counts),
  });
}

export async function POST(req: Request) {
  if (!(await requireStaff())) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, message: 'A valid job id is required' }, { status: 400 });
  }

  const [job] = await db.update(internalJobs).set({
    status: 'pending',
    attemptCount: 0,
    nextRetryAt: null,
    error: null,
    processedAt: null,
  }).where(and(
    eq(internalJobs.id, id),
    eq(internalJobs.status, 'dead_letter'),
  )).returning({ id: internalJobs.id });

  if (!job) {
    return NextResponse.json({ success: false, message: 'Dead-letter job not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true, id: job.id });
}
