import { NextResponse } from 'next/server';
import { authorizePortalSite, isAuthError } from '@/lib/portal-auth';
import { db } from '@/lib/db';
import { clientWebsites, siteBranding, brandingProfiles } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { revalidateSiteChrome } from '@/lib/sites/site-cache';

const DEFAULTS = {
  logoUrl: '',
  logoAlt: '',
  logoSquareUrl: '',
  logoRectUrl: '',
  logoText: '',
  logoIconUrl: '',
  primaryColor: '#2563eb',
  secondaryColor: '#1e40af',
  accentColor: '#f59e0b',
  backgroundColor: '#ffffff',
  textColor: '#111827',
  headingFont: '',
  bodyFont: '',
  navTemplate: 'classic',
  navPosition: 'top',
  navBackground: '#ffffff',
  navTextColor: '#111827',
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const { siteId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'read',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;

  const [branding] = await db.select().from(siteBranding)
    .where(eq(siteBranding.websiteId, authorized.site.id))
    .limit(1);

  return NextResponse.json({ success: true, data: branding || { websiteId: authorized.site.id, ...DEFAULTS } });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const { siteId } = await params;
  const authorized = await authorizePortalSite({
    siteId: parseInt(siteId, 10),
    action: 'admin',
    observeRole: false,
  });
  if (isAuthError(authorized)) return authorized.response;
  const site = authorized.site;

  const body = await req.json();
  const values = {
    websiteId: site.id,
    logoUrl: body.logoUrl ?? DEFAULTS.logoUrl,
    logoAlt: body.logoAlt ?? DEFAULTS.logoAlt,
    logoSquareUrl: body.logoSquareUrl ?? DEFAULTS.logoSquareUrl,
    logoRectUrl: body.logoRectUrl ?? DEFAULTS.logoRectUrl,
    logoText: body.logoText ?? DEFAULTS.logoText,
    logoIconUrl: body.logoIconUrl ?? DEFAULTS.logoIconUrl,
    primaryColor: body.primaryColor ?? DEFAULTS.primaryColor,
    secondaryColor: body.secondaryColor ?? DEFAULTS.secondaryColor,
    accentColor: body.accentColor ?? DEFAULTS.accentColor,
    backgroundColor: body.backgroundColor ?? DEFAULTS.backgroundColor,
    textColor: body.textColor ?? DEFAULTS.textColor,
    headingFont: body.headingFont ?? DEFAULTS.headingFont,
    bodyFont: body.bodyFont ?? DEFAULTS.bodyFont,
    typography: body.typography ?? null,
    darkMode: body.darkMode ?? null,
    navTemplate: body.navTemplate ?? DEFAULTS.navTemplate,
    navPosition: body.navPosition ?? DEFAULTS.navPosition,
    navBackground: body.navBackground ?? DEFAULTS.navBackground,
    navTextColor: body.navTextColor ?? DEFAULTS.navTextColor,
    borderRadius: body.borderRadius ?? null,
    linkColor: body.linkColor ?? null,
    linkHoverColor: body.linkHoverColor ?? null,
    buttonStyle: body.buttonStyle ?? null,
    faviconUrl: body.faviconUrl ?? null,
    ogImageUrl: body.ogImageUrl ?? null,
    updatedAt: new Date(),
  };

  const [existing] = await db.select({ id: siteBranding.id }).from(siteBranding)
    .where(eq(siteBranding.websiteId, site.id))
    .limit(1);

  let result;
  if (existing) {
    [result] = await db.update(siteBranding).set(values)
      .where(eq(siteBranding.id, existing.id))
      .returning();
  } else {
    [result] = await db.insert(siteBranding).values(values).returning();
  }

  const [siteRow] = await db.select({ brandingProfileId: clientWebsites.brandingProfileId })
    .from(clientWebsites)
    .where(eq(clientWebsites.id, site.id))
    .limit(1);

  if (siteRow?.brandingProfileId) {
    await db.update(brandingProfiles).set({
      logoUrl: values.logoUrl || null,
      logoAlt: values.logoAlt || null,
      primaryColor: values.primaryColor,
      secondaryColor: values.secondaryColor,
      accentColor: values.accentColor,
      backgroundColor: values.backgroundColor,
      textColor: values.textColor,
      headingFont: values.headingFont || null,
      bodyFont: values.bodyFont || null,
      navTemplate: values.navTemplate,
      navBackground: values.navBackground,
      navTextColor: values.navTextColor,
      linkColor: values.linkColor,
      linkHoverColor: values.linkHoverColor,
      buttonStyle: values.buttonStyle,
      faviconUrl: values.faviconUrl,
      ogImageUrl: values.ogImageUrl,
      updatedAt: new Date(),
    }).where(eq(brandingProfiles.id, siteRow.brandingProfileId));
  }

  revalidateSiteChrome(site.id);
  return NextResponse.json({ success: true, data: result });
}
