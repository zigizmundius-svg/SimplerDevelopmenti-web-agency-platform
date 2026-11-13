// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const authorizePortalSiteMock = vi.fn();
vi.mock('@/lib/portal-auth', () => ({
  authorizePortalSite: (...args: unknown[]) => authorizePortalSiteMock(...args),
  isAuthError: (value: unknown) =>
    typeof value === 'object' && value !== null && 'response' in value,
}));

const selectMock = vi.fn();
const updateMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...args), update: (...args: unknown[]) => updateMock(...args) },
}));

vi.mock('@/lib/db/schema', () => ({
  clientWebsites: { id: 'website.id' },
  postTypes: { id: 'postTypes.id' },
  users: { id: 'users.id', name: 'users.name', email: 'users.email' },
}));
vi.mock('@/lib/sites/publish-custom-code', () => ({ discardSiteCustomCodeDraft: vi.fn() }));

vi.mock('drizzle-orm', () => ({ eq: (a: unknown, b: unknown) => ({ a, b }) }));

const codeRoute = await import('@/app/api/portal/cms/websites/[siteId]/code/route');
const publishRoute = await import('@/app/api/portal/cms/websites/[siteId]/code/publish/route');
const discardRoute = await import('@/app/api/portal/cms/websites/[siteId]/code/discard/route');
const contentTypeCodeRoute = await import('@/app/api/portal/cms/websites/[siteId]/content-types/[typeId]/code/route');

const forbidden = () => ({
  response: new Response(JSON.stringify({ success: false, message: 'Forbidden' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  }),
});

beforeEach(() => {
  authorizePortalSiteMock.mockReset();
  selectMock.mockReset();
  updateMock.mockReset();
});

describe('custom website code role enforcement', () => {
  it('requires admin permission to read custom code', async () => {
    authorizePortalSiteMock.mockResolvedValue(forbidden());
    const response = await codeRoute.GET(new Request('http://local'), {
      params: Promise.resolve({ siteId: '7' }),
    });

    expect(response.status).toBe(403);
    expect(authorizePortalSiteMock).toHaveBeenCalledWith({
      siteId: 7,
      action: 'admin',
      observeRole: false,
    });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('requires admin permission to save draft custom code', async () => {
    authorizePortalSiteMock.mockResolvedValue(forbidden());
    const response = await codeRoute.PUT(
      new Request('http://local', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customJs: 'alert(1)' }),
      }),
      { params: Promise.resolve({ siteId: '7' }) },
    );

    expect(response.status).toBe(403);
    expect(authorizePortalSiteMock).toHaveBeenCalledWith({
      siteId: 7,
      action: 'admin',
      observeRole: false,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('requires admin permission to publish custom code', async () => {
    authorizePortalSiteMock.mockResolvedValue(forbidden());
    const response = await publishRoute.POST(new Request('http://local', { method: 'POST' }), {
      params: Promise.resolve({ siteId: '7' }),
    });

    expect(response.status).toBe(403);
    expect(authorizePortalSiteMock).toHaveBeenCalledWith({
      siteId: 7,
      action: 'admin',
      observeRole: false,
    });
  });

  it('requires admin permission to discard custom code drafts', async () => {
    authorizePortalSiteMock.mockResolvedValue(forbidden());
    const response = await discardRoute.POST(new Request('http://local', { method: 'POST' }), {
      params: Promise.resolve({ siteId: '7' }),
    });

    expect(response.status).toBe(403);
    expect(authorizePortalSiteMock).toHaveBeenCalledWith({
      siteId: 7,
      action: 'admin',
      observeRole: false,
    });
  });

  it('requires admin permission to read content-type custom code', async () => {
    authorizePortalSiteMock.mockResolvedValue(forbidden());
    const response = await contentTypeCodeRoute.GET(new Request('http://local'), {
      params: Promise.resolve({ siteId: '7', typeId: '2' }),
    });

    expect(response.status).toBe(403);
    expect(authorizePortalSiteMock).toHaveBeenCalledWith({
      siteId: 7,
      action: 'admin',
      observeRole: false,
    });
  });

  it('requires admin permission to update content-type custom code', async () => {
    authorizePortalSiteMock.mockResolvedValue(forbidden());
    const response = await contentTypeCodeRoute.PUT(
      new Request('http://local', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customJs: 'alert(1)' }),
      }),
      { params: Promise.resolve({ siteId: '7', typeId: '2' }) },
    );

    expect(response.status).toBe(403);
    expect(authorizePortalSiteMock).toHaveBeenCalledWith({
      siteId: 7,
      action: 'admin',
      observeRole: false,
    });
    expect(updateMock).not.toHaveBeenCalled();
  });
});
