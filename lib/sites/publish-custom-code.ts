// Server-only helper that promotes the per-site DRAFT custom CSS/JS into the
// live columns and clears the draft state. Factored out so both the portal
// REST endpoint and the MCP approval path can share the same exact write.
// When supplied, the client ID is included in publish database predicates as a
// defense-in-depth tenant boundary.

import { db } from '@/lib/db';
import { clientWebsites } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { revalidateSiteChrome } from '@/lib/sites/site-cache';

export interface PublishCustomCodeResult {
  customCss: string;
  customJs: string;
}

/**
 * Promotes the current draft and clears its metadata.
 *
 * The row is locked inside a transaction while the draft is read and promoted.
 * This prevents a concurrent draft save from being cleared after the publisher
 * has read an older draft (a lost-update race).
 */
export async function publishSiteCustomCode(siteId: number, clientId?: number): Promise<PublishCustomCodeResult> {
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: clientWebsites.id,
        draftCustomCss: clientWebsites.draftCustomCss,
        draftCustomJs: clientWebsites.draftCustomJs,
        customCss: clientWebsites.customCss,
        customJs: clientWebsites.customJs,
      })
      .from(clientWebsites)
      .where(clientId === undefined ? eq(clientWebsites.id, siteId) : and(eq(clientWebsites.id, siteId), eq(clientWebsites.clientId, clientId)))
      .for('update')
      .limit(1);

    if (!existing) throw new Error('Site not found');

    // Re-check publishability while holding the row lock. The portal route's
    // earlier preflight is only a UX optimization and may be stale if another
    // editor discarded or published the draft before this transaction began.
    const noDraft = existing.draftCustomCss === null && existing.draftCustomJs === null;
    const draftMatchesLive =
      (existing.draftCustomCss ?? null) === (existing.customCss ?? null) &&
      (existing.draftCustomJs ?? null) === (existing.customJs ?? null);
    if (noDraft || draftMatchesLive) throw new Error('No draft changes to publish');

    const [row] = await tx
      .update(clientWebsites)
      .set({
        customCss: existing.draftCustomCss ?? existing.customCss,
        customJs: existing.draftCustomJs ?? existing.customJs,
        draftCustomCss: null,
        draftCustomJs: null,
        draftUpdatedAt: null,
        draftUpdatedBy: null,
        updatedAt: new Date(),
      })
      .where(clientId === undefined ? eq(clientWebsites.id, siteId) : and(eq(clientWebsites.id, siteId), eq(clientWebsites.clientId, clientId)))
      .returning();

    return {
      customCss: row.customCss || '',
      customJs: row.customJs || '',
    };
  });

  // Revalidate only after the transaction commits successfully.
  revalidateSiteChrome(siteId);
  return result;
}

/**
 * Clears the draft custom CSS/JS without touching live. Used by the portal
 * "Discard draft" affordance. Caller must scope to the acting client first.
 */
export async function discardSiteCustomCodeDraft(siteId: number): Promise<void> {
  await db
    .update(clientWebsites)
    .set({
      draftCustomCss: null,
      draftCustomJs: null,
      draftUpdatedAt: null,
      draftUpdatedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(clientWebsites.id, siteId));
}
