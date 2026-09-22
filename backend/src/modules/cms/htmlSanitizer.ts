import sanitizeHtml from 'sanitize-html';

/**
 * The single HTML allowlist. Used by CUSTOM_HTML and RICH_TEXT blocks and by HelpArticle bodies.
 *
 * Everything here is admin-authored, and an admin account is not a trust boundary we want to bet
 * the storefront on: a compromised or careless content editor must not be able to run script in a
 * customer's session, read their cart, or point a form at somebody else's server.
 *
 * This wraps `sanitize-html` rather than hand-rolling a parser. A regex-based sanitiser is a
 * well-known way to ship an XSS hole — `<scr<script>ipt>`, mixed-case entities, malformed nesting
 * and unclosed attributes all defeat the naive versions. The library tokenises properly.
 *
 * Sanitising happens at WRITE time and the result is stored. Read paths never sanitise: that would
 * put a parser on the hot path of every page render, and it would mean the bytes in the database
 * are not the bytes we vouched for.
 */

/** Hosts an <iframe> may point at. Overridable per install via cms.whitelisted_iframe_hosts. */
export const DEFAULT_IFRAME_HOSTS = [
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'player.vimeo.com',
] as const;

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'div', 'span', 'section', 'article',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark', 'small',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'iframe',
];

/**
 * Note what is NOT here: `style` (CSS can exfiltrate and can cover the page), `srcset`/`onload`,
 * `formaction`, and anything `on*`. `class` survives so the storefront can theme content.
 */
const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  '*': ['class', 'id', 'dir', 'lang', 'title'],
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'frameborder', 'loading'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  col: ['span'],
};

export interface SanitizeOptions {
  /** Extra iframe hosts from settings. Merged with the defaults, never replacing them. */
  iframeHosts?: readonly string[];
  /** Drop iframes entirely. Used for help articles, which have no reason to embed anything. */
  allowIframes?: boolean;
}

function optionsFor(options: SanitizeOptions = {}): sanitizeHtml.IOptions {
  const allowIframes = options.allowIframes ?? true;
  const hosts = [...new Set([...DEFAULT_IFRAME_HOSTS, ...(options.iframeHosts ?? [])])];

  return {
    allowedTags: allowIframes ? ALLOWED_TAGS : ALLOWED_TAGS.filter((tag) => tag !== 'iframe'),
    allowedAttributes: ALLOWED_ATTRIBUTES,

    // The scheme allowlist. `javascript:`, `vbscript:` and `file:` are absent by omission.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: {
      // `data:` images are how an SVG-with-script payload usually arrives.
      img: ['http', 'https'],
      iframe: ['https'],
    },
    allowProtocolRelative: false,

    allowedIframeHostnames: hosts,
    allowIframeRelativeUrls: false,

    // Content of these is DISCARDED, not merely untagged. Untagging <script> leaves the source
    // sitting in the document as text, which is fine for display but is still the payload.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template'],

    transformTags: {
      // Any link that opens a new tab gets rel=noopener, or the target page can reach window.opener.
      a: (tagName, attribs) => {
        const next: Record<string, string> = { ...attribs };
        if (next.target === '_blank') next.rel = 'noopener noreferrer nofollow';
        return { tagName, attribs: next };
      },
      iframe: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, loading: 'lazy', referrerpolicy: 'no-referrer' },
      }),
    },

    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: true,

    /**
     * Stripping a disallowed `src` leaves `<iframe></iframe>` behind. It cannot load anything, but
     * it is still a frame in the layout and it tells an attacker exactly which host was rejected.
     * Drop the element instead.
     */
    exclusiveFilter: (frame) => frame.tag === 'iframe' && !frame.attribs.src,
  };
}

/** Sanitised markup, safe to store and to render without further processing. */
export function sanitizeRichHtml(html: string, options: SanitizeOptions = {}): string {
  if (!html) return '';
  return sanitizeHtml(html, optionsFor(options));
}

/** Strips every tag. For excerpts, meta descriptions and the search index. */
export function toPlainText(html: string, maxLength = 5_000): string {
  // Block boundaries become spaces first: otherwise "<h2>Delivery</h2><p>Ships" indexes as
  // "DeliveryShips" and neither the excerpt nor the search document finds either word.
  const spaced = (html ?? '').replace(/<\/(p|div|h[1-6]|li|tr|td|th|section|article|blockquote|pre)>/gi, ' $& ')
    .replace(/<br\s*\/?>/gi, ' ');

  const stripped = sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} });

  return stripped
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** True when sanitising changed anything, so the admin can be told what was stripped. */
export function wasModified(raw: string, sanitised: string): boolean {
  return raw.trim() !== sanitised.trim();
}
