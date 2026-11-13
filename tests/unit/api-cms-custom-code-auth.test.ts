// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const authorizePortalSiteMock = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: '1', role: 'client' } })) }));

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
  customFields: { id: 'customFields.id', postTypeId: 'customFields.postTypeId', fieldType: 'customFields.fieldType', order: 'customFields.order' },
  taxonomies: { id: 'taxonomies.id', websiteId: 'taxonomies.websiteId', builtIn: 'taxonomies.builtIn' },
  taxonomyTerms: { id: 'taxonomyTerms.id', taxonomyId: 'taxonomyTerms.taxonomyId', sortOrder: 'taxonomyTerms.sortOrder', name: 'taxonomyTerms.name' },
  users: { id: 'users.id', name: 'users.name', email: 'users.email' },
}));
vi.mock('@/lib/sites/publish-custom-code', () => ({ discardSiteCustomCodeDraft: vi.fn() }));

vi.mock('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
  and: (...conditions: unknown[]) => ({ conditions }),
  or: (...conditions: unknown[]) => ({ conditions }),
  asc: (value: unknown) => value,
  desc: (value: unknown) => value,
  isNull: (value: unknown) => ({ isNull: value }),
  inArray: (column: unknown, values: unknown[]) => ({ column, values }),
}));

const codeRoute = await import('@/app/api/portal/cms/websites/[siteId]/code/route');
const publishRoute = await import('@/app/api/portal/cms/websites/[siteId]/code/publish/route');
const discardRoute = await import('@/app/api/portal/cms/websites/[siteId]/code/discard/route');
const contentTypeCodeRoute = await import('@/app/api/portal/cms/websites/[siteId]/content-types/[typeId]/code/route');
const contentTypeTemplateRoute = await import('@/app/api/portal/cms/websites/[siteId]/content-types/[typeId]/template/route');
const contentTypeFieldsRoute = await import('@/app/api/portal/cms/websites/[siteId]/content-types/[typeId]/fields/route');
const taxonomyTermsRoute = await import('@/app/api/portal/cms/websites/[siteId]/taxonomies/[taxonomyId]/terms/route');

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

  it('requires write permission to change a content-type template', async () => {
    authorizePortalSiteMock.mockResolvedValue(forbidden());
    const response = await contentTypeTemplateRoute.PUT(
      new Request('http://local', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template: { blocks: [] } }),
      }),
      { params: Promise.resolve({ siteId: '7', typeId: '2' }) },
    );

    expect(response.status).toBe(403);
    expect(authorizePortalSiteMock).toHaveBeenCalledWith({
      siteId: 7,
      action: 'write',
      observeRole: false,
    });
  });

  it('requires write permission to create a custom content field', async () => {
    authorizePortalSiteMock.mockResolvedValue(forbidden());
    const response = await contentTypeFieldsRoute.POST(
      new Request('http://local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Size', slug: 'size', fieldType: 'text' }),
      }),
      { params: Promise.resolve({ siteId: '7', typeId: '2' }) },
    );

    expect(response.status).toBe(403);
    expect(authorizePortalSiteMock).toHaveBeenCalledWith({
      siteId: 7,
      action: 'write',
      observeRole: false,
    });
  });

  it('requires write permission before adding terms to a taxonomy', async () => {
    authorizePortalSiteMock.mockResolvedValue(forbidden());
    const response = await taxonomyTermsRoute.POST(
      new Request('http://local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'News', slug: 'news' }),
      }),
      { params: Promise.resolve({ siteId: '7', taxonomyId: '3' }) },
    );

    expect(response.status).toBe(403);
    expect(authorizePortalSiteMock).toHaveBeenCalledWith({
      siteId: 7,
      action: 'write',
      observeRole: false,
    });
  });
});
