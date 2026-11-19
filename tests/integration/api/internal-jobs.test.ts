import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/lib/db/schema';
import { drainInternalJobs, enqueueJob } from '@/lib/jobs';
import { getTestSql, TEST_SCHEMA } from '../../helpers/test-db';
import { sessionForNewClientUser } from '../../helpers/session';

describe('internal job queue lease recovery @jobs @integration', () => {
  it('atomically reclaims expired leases and dead-letters at the attempt limit under concurrent drainers', async () => {
    const tenant = await sessionForNewClientUser('internal-jobs');
    const sql = getTestSql();

    const [retryable] = await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.internal_jobs (
        client_id, type, payload, status, attempt_count, next_retry_at, dedupe_key
      ) VALUES (
        ${tenant.client.id}, 'pod.submit', '{}'::json, 'running', 0,
        NOW() - INTERVAL '1 minute', 'test:lease-retryable'
      )
      RETURNING id
    `;
    const [exhausted] = await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.internal_jobs (
        client_id, type, payload, status, attempt_count, next_retry_at, dedupe_key
      ) VALUES (
        ${tenant.client.id}, 'pod.submit', '{}'::json, 'running', 2,
        NOW() - INTERVAL '1 minute', 'test:lease-exhausted'
      )
      RETURNING id
    `;

    // Use independent PostgreSQL pools so the two drainers can truly race;
    // the application's default pool is intentionally max=1.
    const secondClient = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const secondDb = drizzle(secondClient, { schema });
    let results;
    try {
      results = await Promise.all([drainInternalJobs(db), drainInternalJobs(secondDb)]);
    } finally {
      await secondClient.end();
    }
    const failed = results.reduce((sum, result) => sum + result.failed, 0);
    const deadLettered = results.reduce((sum, result) => sum + result.deadLettered, 0);

    expect(failed).toBe(1);
    expect(deadLettered).toBe(1);

    const rows = await sql`
      SELECT id, status, attempt_count, next_retry_at
      FROM ${sql(TEST_SCHEMA)}.internal_jobs
      WHERE id IN (${retryable.id}, ${exhausted.id})
      ORDER BY id
    `;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: retryable.id, status: 'pending', attempt_count: 1 });
    expect(rows[0].next_retry_at).toBeInstanceOf(Date);
    expect(rows[1]).toMatchObject({ id: exhausted.id, status: 'dead_letter', attempt_count: 3 });
    expect(rows[1].next_retry_at).toBeNull();
  });

  it('deduplicates repeated enqueue requests using the unique database key', async () => {
    const tenant = await sessionForNewClientUser('internal-jobs-dedupe');

    await Promise.all([
      enqueueJob({
        clientId: tenant.client.id,
        type: 'pod.submit',
        payload: { orderId: 123 },
        dedupeKey: 'test:dedupe-single-job',
      }, db),
      enqueueJob({
        clientId: tenant.client.id,
        type: 'pod.submit',
        payload: { orderId: 123 },
        dedupeKey: 'test:dedupe-single-job',
      }, db),
    ]);

    const sql = getTestSql();
    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM ${sql(TEST_SCHEMA)}.internal_jobs
      WHERE client_id = ${tenant.client.id}
        AND dedupe_key = 'test:dedupe-single-job'
    `;
    expect(rows[0].count).toBe(1);
  });


  it('allows only one concurrent drainer to claim and consume a due job', async () => {
    const tenant = await sessionForNewClientUser('internal-jobs-claim-race');
    const sql = getTestSql();
    const dedupeKey = `test:claim-race:${tenant.client.id}`;
    const [inserted] = await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.internal_jobs (
        client_id, type, payload, status, attempt_count, next_retry_at, dedupe_key
      ) VALUES (
        ${tenant.client.id}, 'test.missing-handler', '{}'::json, 'pending', 0, NULL, ${dedupeKey}
      )
      RETURNING id
    `;

    const secondClient = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const secondDb = drizzle(secondClient, { schema });
    let results;
    try {
      results = await Promise.all([drainInternalJobs(db), drainInternalJobs(secondDb)]);
    } finally {
      await secondClient.end();
    }

    // Both workers may read the due row, but only one pending -> running CAS
    // can win. The missing handler makes that single claimed attempt retryable.
    expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(0);

    const [job] = await sql`
      SELECT status, attempt_count, error, next_retry_at
      FROM ${sql(TEST_SCHEMA)}.internal_jobs
      WHERE id = ${inserted.id}
    `;
    expect(job).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      error: "No handler registered for job type 'test.missing-handler'",
    });
    expect(job.next_retry_at).toBeInstanceOf(Date);
  });

});
