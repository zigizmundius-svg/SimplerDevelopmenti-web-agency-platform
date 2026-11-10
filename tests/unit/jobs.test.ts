import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));
import { drainInternalJobs, MAX_ATTEMPTS } from '@/lib/jobs';

function makeDb(reclaimedRows: Array<{ status: 'pending' | 'dead_letter' }>) {
  type Builder = {
    set(values: Record<string, unknown>): Builder;
    where(condition?: unknown): Builder;
    returning(): Promise<Array<{ status: 'pending' | 'dead_letter' }>>;
    from(table: unknown): Builder;
    orderBy(order: unknown): Builder;
    limit(count: number): Promise<never[]>;
  };
  const updates: Array<Record<string, unknown>> = [];

  const db = {
    update: vi.fn(() => {
      const builder = {} as Builder;
      builder.set = (values) => {
        updates.push(values);
        return builder;
      };
      builder.where = () => builder;
      builder.returning = async () => reclaimedRows;
      return builder;
    }),
    select: vi.fn(() => {
      const builder = {} as Builder;
      builder.from = () => builder;
      builder.where = () => builder;
      builder.orderBy = () => builder;
      builder.limit = async () => [];
      return builder;
    }),
  };

  return { db, updates };
}

describe('drainInternalJobs lease recovery', () => {
  it('counts expired leases reclaimed for a bounded retry', async () => {
    const { db, updates } = makeDb([{ status: 'pending' }, { status: 'pending' }]);

    const result = await drainInternalJobs(db as never);

    expect(result).toEqual({ processed: 0, failed: 2, deadLettered: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveProperty('attemptCount');
    expect(updates[0]).toHaveProperty('status');
    expect(updates[0]).toHaveProperty('nextRetryAt');
    expect(updates[0]).toHaveProperty('error');
  });

  it('counts expired leases moved directly to dead letter at the attempt limit', async () => {
    const { db, updates } = makeDb([{ status: 'dead_letter' }]);

    const result = await drainInternalJobs(db as never);

    expect(result).toEqual({ processed: 0, failed: 0, deadLettered: 1 });
    expect(MAX_ATTEMPTS).toBe(3);
    expect(updates[0]).toHaveProperty('attemptCount');
  });

  it('does not count when no expired lease was reclaimed', async () => {
    const { db, updates } = makeDb([]);

    const result = await drainInternalJobs(db as never);

    expect(result).toEqual({ processed: 0, failed: 0, deadLettered: 0 });
    expect(updates).toHaveLength(1);
  });
});
