import { log, prisma } from './context';

/**
 * Site-wide content and SEO settings.
 *
 * These are the values a shop owner changes without a deploy: the phone number on every page, the
 * WhatsApp link, the title template. Public ones are served through the EXISTING
 * /api/v1/settings/public endpoint — there is no second settings API.
 */

interface Setting {
  key: string;
  value: string;
  valueType: 'string' | 'number' | 'boolean' | 'json';
  group: string;
  isPublic: boolean;
}

const SETTINGS: Setting[] = [
  { key: 'site.contact_phone', value: '+91 99999 99999', valueType: 'string', group: 'content', isPublic: true },
  { key: 'site.whatsapp_number', value: '919999999999', valueType: 'string', group: 'content', isPublic: true },
  { key: 'site.support_email', value: 'care@clearwood.in', valueType: 'string', group: 'content', isPublic: true },
  {
    key: 'site.address',
    value: 'ClearWood Furnitures, Plot 14, Peenya Industrial Area, Bengaluru 560058',
    valueType: 'string',
    group: 'content',
    isPublic: true,
  },
  { key: 'site.gstin_display', value: '29AABCC1234D1ZP', valueType: 'string', group: 'content', isPublic: true },
  { key: 'site.social.instagram', value: 'https://instagram.com/clearwoodfurnitures', valueType: 'string', group: 'content', isPublic: true },
  { key: 'site.social.facebook', value: 'https://facebook.com/clearwoodfurnitures', valueType: 'string', group: 'content', isPublic: true },
  { key: 'site.social.youtube', value: 'https://youtube.com/@clearwoodfurnitures', valueType: 'string', group: 'content', isPublic: true },
  { key: 'site.social.pinterest', value: 'https://pinterest.com/clearwoodfurnitures', valueType: 'string', group: 'content', isPublic: true },
  { key: 'site.social.linkedin', value: 'https://linkedin.com/company/clearwoodfurnitures', valueType: 'string', group: 'content', isPublic: true },
  {
    key: 'site.business_hours',
    value: 'Monday to Saturday, 10am to 7pm. Sunday by appointment.',
    valueType: 'string',
    group: 'content',
    isPublic: true,
  },
  { key: 'site.announcement_enabled', value: 'true', valueType: 'boolean', group: 'content', isPublic: true },
  { key: 'site.newsletter_enabled', value: 'true', valueType: 'boolean', group: 'content', isPublic: true },
  {
    key: 'site.usp_lines',
    value: JSON.stringify([
      'Made in our own workshop, never outsourced',
      'Built to order in solid wood',
      '25,000+ homes furnished since 2009',
      'Three-year structural warranty',
    ]),
    valueType: 'json',
    group: 'content',
    isPublic: true,
  },

  {
    key: 'seo.default_title_template',
    value: '%s | ClearWood Furnitures',
    valueType: 'string',
    group: 'seo',
    isPublic: true,
  },
  {
    key: 'seo.default_description',
    value:
      'Solid wood furniture made in our own Bengaluru workshop. Sofas, beds, dining and storage, built to order and delivered across India.',
    valueType: 'string',
    group: 'seo',
    isPublic: true,
  },
  { key: 'seo.og_default_media_id', value: '', valueType: 'string', group: 'seo', isPublic: true },
  { key: 'seo.robots_extra', value: '', valueType: 'string', group: 'seo', isPublic: false },
  { key: 'seo.google_site_verification', value: '', valueType: 'string', group: 'seo', isPublic: false },

  // Private: widening this is a security decision, not a content one.
  {
    key: 'cms.whitelisted_iframe_hosts',
    value: 'www.youtube.com,www.youtube-nocookie.com,player.vimeo.com',
    valueType: 'string',
    group: 'cms',
    isPublic: false,
  },
];

export async function seedCmsSettings(): Promise<void> {
  for (const setting of SETTINGS) {
    await prisma.appSetting.upsert({
      where: { key: setting.key },
      create: setting,
      // R8 — an admin's edited VALUE survives a re-seed; only the metadata is refreshed.
      update: {
        valueType: setting.valueType,
        group: setting.group,
        isPublic: setting.isPublic,
      },
    });
  }

  log('cms-settings', `${SETTINGS.length} settings`);
}
