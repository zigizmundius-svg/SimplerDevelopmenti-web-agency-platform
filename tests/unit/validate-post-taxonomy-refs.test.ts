// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { whereMock, selectMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}));
vi.mock('@/lib/db/schema', () => ({
  categories: { id: 'categories.id', websiteId: 'categories.websiteId' },
  tags: { id: 'tags.id', websiteId: 'tags.websiteId' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ column, values }),
}));

import { validatePostTaxonomyRefs } from '@/lib/sites/validate-post-taxonomy-refs';

describe('validatePostTaxonomyRefs', () => {
  beforeEach(() => {
    whereMock.mockReset();
    selectMock.mockReset();
    selectMock.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: whereMock }),
    });
  });

  it('rejects category IDs that are not attached to the current website', async () => {
    whereMock.mockResolvedValue([]);
    await expect(validatePostTaxonomyRefs(12, [44], [])).resolves.toEqual({
      valid: false,
      message: 'One or more categories do not belong to this website.',
    });
  });

  it('rejects non-array and non-positive taxonomy IDs', async () => {
    await expect(validatePostTaxonomyRefs(12, ['44'], [])).resolves.toEqual({
      valid: false,
      message: 'categoryIds must be an array of positive integer IDs.',
    });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('deduplicates IDs and accepts site-scoped categories and tags', async () => {
    whereMock.mockResolvedValue([{ id: 44 }]);
    await expect(validatePostTaxonomyRefs(12, [44, 44], [55])).resolves.toEqual({ valid: true });
    expect(whereMock).toHaveBeenCalledTimes(2);
  });

  it('allows omitted or empty associations without querying', async () => {
    await expect(validatePostTaxonomyRefs(12, undefined, null)).resolves.toEqual({ valid: true });
    expect(selectMock).not.toHaveBeenCalled();
  });
});
