import { afterEach, describe, expect, it } from 'vitest';
import { isAuthorizedCron } from '@/lib/cron-auth';

const makeRequest = (headers?: HeadersInit) =>
  new Request('http://localhost/api/cron/test', { headers });

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('isAuthorizedCron', () => {
  it('fails closed when CRON_SECRET is missing, even if the Vercel marker is present', () => {
    delete process.env.CRON_SECRET;

    expect(isAuthorizedCron(makeRequest({ 'x-vercel-cron': '1' }))).toBe(false);
    expect(isAuthorizedCron(makeRequest())).toBe(false);
  });

  it('accepts only the exact configured Bearer secret', () => {
    process.env.CRON_SECRET = 'test-cron-secret';

    expect(
      isAuthorizedCron(makeRequest({ authorization: 'Bearer test-cron-secret' })),
    ).toBe(true);
  });

  it('rejects a forged Vercel marker and incorrect Bearer credentials', () => {
    process.env.CRON_SECRET = 'test-cron-secret';

    expect(isAuthorizedCron(makeRequest({ 'x-vercel-cron': '1' }))).toBe(false);
    expect(isAuthorizedCron(makeRequest({ authorization: 'Bearer wrong-secret' }))).toBe(false);
    expect(isAuthorizedCron(makeRequest({ authorization: 'bearer test-cron-secret' }))).toBe(false);
  });
});
