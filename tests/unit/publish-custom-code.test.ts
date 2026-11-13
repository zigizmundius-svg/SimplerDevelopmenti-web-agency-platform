// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, revalidateMock } = vi.hoisted(() => ({
  dbMock: { transaction: vi.fn() },
  revalidateMock: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: dbMock }));
vi.mock('@/lib/db/schema', () => ({
  clientWebsites: new Proxy({}, { get: (_target, key) => ({ column: String(key) }) }),
}));
vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
}));
vi.mock('@/lib/sites/site-cache', () => ({ revalidateSiteChrome: revalidateMock }));

import { publishSiteCustomCode } from '@/lib/sites/publish-custom-code';

function setup(existing: Record<string, unknown> | null) {
  const limit = vi.fn().mockResolvedValue(existing ? [existing] : []);
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    for: vi.fn().mockReturnThis(),
    limit,
  };
  const returning = vi.fn().mockResolvedValue([{ customCss: 'new css', customJs: '' }]);
  const set = vi.fn().mockReturnThis();
  const updateChain = {
    set,
    where: vi.fn().mockReturnThis(),
    returning,
  };
  const tx = {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
  };
  dbMock.transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) => callback(tx));
  return { tx, selectChain, updateChain, set, returning, limit };
}

describe('publishSiteCustomCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a stale publish when the draft was cleared before the row lock', async () => {
    const state = setup({
      id: 7,
      draftCustomCss: null,
      draftCustomJs: null,
      customCss: 'live css',
      customJs: 'live js',
    });

    await expect(publishSiteCustomCode(7, 10)).rejects.toThrow('No draft changes to publish');
    expect(state.tx.update).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it('promotes the locked draft and revalidates only after transaction success', async () => {
    const state = setup({
      id: 7,
      draftCustomCss: 'new css',
      draftCustomJs: '',
      customCss: 'old css',
      customJs: 'old js',
    });

    await expect(publishSiteCustomCode(7, 10)).resolves.toEqual({
      customCss: 'new css',
      customJs: '',
    });
    expect(state.selectChain.for).toHaveBeenCalledWith('update');
    expect(state.set).toHaveBeenCalledWith(expect.objectContaining({
      customCss: 'new css',
      customJs: '',
      draftCustomCss: null,
      draftCustomJs: null,
    }));
    expect(revalidateMock).toHaveBeenCalledWith(7);
  });

  it('preserves live JS when only a CSS draft exists', async () => {
    const state = setup({
      id: 7,
      draftCustomCss: 'new css',
      draftCustomJs: null,
      customCss: 'old css',
      customJs: 'keep this live JS',
    });

    await publishSiteCustomCode(7, 10);
    expect(state.set).toHaveBeenCalledWith(expect.objectContaining({
      customCss: 'new css',
      customJs: 'keep this live JS',
    }));
  });

  it('does not revalidate when the site is outside the tenant scope', async () => {
    setup(null);
    await expect(publishSiteCustomCode(7, 99)).rejects.toThrow('Site not found');
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});
