import { db } from '@/lib/db';
import { categories, tags } from '@/lib/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

export interface PostTaxonomyRefsValidation {
  valid: boolean;
  message?: string;
}

/**
 * Ensures category/tag associations supplied by a portal post editor belong
 * to the same website as the post. Join tables do not carry tenant IDs, so
 * accepting arbitrary IDs here would let one tenant attach another tenant's
 * taxonomy rows to its content.
 */
export async function validatePostTaxonomyRefs(
  websiteId: number,
  categoryIds: unknown,
  tagIds: unknown,
): Promise<PostTaxonomyRefsValidation> {
  const validateIds = (value: unknown): number[] | null => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      return null;
    }
    return [...new Set(value as number[])];
  };

  const categoryList = validateIds(categoryIds);
  if (!categoryList) return { valid: false, message: 'categoryIds must be an array of positive integer IDs.' };
  const tagList = validateIds(tagIds);
  if (!tagList) return { valid: false, message: 'tagIds must be an array of positive integer IDs.' };

  if (categoryList.length) {
    const rows = await db.select({ id: categories.id }).from(categories)
      .where(and(eq(categories.websiteId, websiteId), inArray(categories.id, categoryList)));
    if (rows.length !== categoryList.length) {
      return { valid: false, message: 'One or more categories do not belong to this website.' };
    }
  }

  if (tagList.length) {
    const rows = await db.select({ id: tags.id }).from(tags)
      .where(and(eq(tags.websiteId, websiteId), inArray(tags.id, tagList)));
    if (rows.length !== tagList.length) {
      return { valid: false, message: 'One or more tags do not belong to this website.' };
    }
  }

  return { valid: true };
}
