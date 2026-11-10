// Shared cron auth check. The Vercel cron marker is informational only:
// request headers can be forged by any caller. Every environment (Vercel,
// VPS, container, external scheduler) must present the shared Bearer secret.
// Missing configuration fails closed so a misconfigured deployment cannot
// accidentally expose privileged maintenance endpoints.

import type { NextRequest } from 'next/server';

export function isAuthorizedCron(req: NextRequest | Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.get('authorization') === `Bearer ${cronSecret}`;
}
